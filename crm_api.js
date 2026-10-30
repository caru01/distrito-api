const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { compileSegment, validateSegmentDefinition } = require('./src/crm/segments');
const { normalizePhoneE164 } = require('./src/crm/phone');
const {
  appendCrmEvent,
  crmError,
  ensureContact,
  ensureConversation,
  maskIdentifier,
  processStoredWhatsAppWebhook,
  queueConversationMessage,
  registerWhatsAppWebhook,
} = require('./src/crm-service');
const { validateWebhookSignature, describeWebhookSignature } = require('./src/whatsapp-cloud');

const CONTACT_STATUSES = new Set([
  'NUEVO_CONTACTO','PROSPECTO','CLIENTE_NUEVO','CLIENTE_RECURRENTE',
  'CLIENTE_FRECUENTE','VIP','INACTIVO','RECUPERADO','NO_CONTACTAR',
]);
const SOURCES = new Set(['WHATSAPP','INSTAGRAM','FACEBOOK','GOOGLE','TIENDA_DIRECTA','PRESENCIAL','QR','CAMPANA','MANUAL','OTRO']);
const CRM_SETTING_FIELDS = new Set([
  'crm_inactive_days','crm_frequent_orders','crm_vip_orders','crm_vip_spend',
  'crm_attribution_days','crm_campaign_frequency_days','crm_campaign_start_time','crm_campaign_end_time',
]);

function positiveInteger(value, fallback, maximum = 100) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function cleanText(value, maximum = 500) {
  return String(value || '').trim().slice(0, maximum);
}

function slugCode(value) {
  return cleanText(value, 80).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function contactFilters(query = {}) {
  const search = cleanText(query.search, 160);
  const status = CONTACT_STATUSES.has(query.status) ? query.status : '';
  const source = SOURCES.has(query.source) ? query.source : '';
  const assigned = /^\d+$/.test(String(query.assigned_user_id || '')) ? Number(query.assigned_user_id) : null;
  const tagId = /^\d+$/.test(String(query.tag_id || '')) ? Number(query.tag_id) : null;
  const minOrders = Math.max(0, Number(query.min_orders) || 0);
  const minSpend = Math.max(0, Number(query.min_spend) || 0);
  const normalizedSearch = normalizePhoneE164(search);
  const orderSearch = /^\d+$/.test(search) ? search : '';
  return {
    values: [`%${search}%`, normalizedSearch, status, source, assigned, tagId, minOrders, minSpend, orderSearch],
    metadata: { search: search || null, status: status || null, source: source || null, assigned, tagId, minOrders, minSpend, orderId: orderSearch || null },
  };
}

const CONTACT_FILTER_SQL = `
  contact.deleted_at IS NULL
  AND ($1='%%' OR contact.display_name ILIKE $1 OR contact.normalized_phone ILIKE $1
    OR contact.email ILIKE $1 OR contact.barrio ILIKE $1 OR contact.username ILIKE $1 OR contact.bsuid ILIKE $1
    OR ($2::text IS NOT NULL AND contact.normalized_phone=$2)
    OR ($9::text<>'' AND EXISTS (
      SELECT 1 FROM pedidos_app_orders filter_order
      WHERE filter_order.crm_contact_id=contact.id AND filter_order.id::text=$9
    )))
  AND ($3='' OR contact.status=$3) AND ($4='' OR contact.source=$4)
  AND ($5::int IS NULL OR contact.assigned_user_id=$5)
  AND ($6::bigint IS NULL OR EXISTS (
    SELECT 1 FROM pedidos_app_crm_contact_tags filter_tag
    WHERE filter_tag.contact_id=contact.id AND filter_tag.tag_id=$6
  ))
  AND contact.orders_count >= $7 AND contact.total_spent >= $8
`;

function respondError(res, error) {
  const known = error.statusCode || (error.code === '23505' ? 409 : 500);
  const code = error.code === '23505' ? 'CRM_DUPLICATE' : (error.code || 'CRM_INTERNAL_ERROR');
  if (known >= 500) console.error(JSON.stringify({ level: 'error', component: 'crm-api', code, message: error.message }));
  return res.status(known).json({ code, error: known >= 500 && code === 'CRM_INTERNAL_ERROR' ? 'No fue posible procesar la operación CRM.' : error.message });
}

async function audit(client, req, action, entity, entityId, metadata = {}) {
  await client.query(`
    INSERT INTO pedidos_app_audit_logs (user_id,username_attempted,module,action,details,ip,request_data)
    VALUES ($1,$2,'CRM',$3,$4,$5,$6::jsonb)
  `, [req.user?.id || null, req.user?.username || null, action, `${entity} ${entityId || ''}`.trim(), req.ip, JSON.stringify(metadata)]);
}

async function readSegment(pool, id) {
  const { rows } = await pool.query('SELECT * FROM pedidos_app_crm_segments WHERE id=$1', [id]);
  if (!rows.length) throw crmError('SEGMENT_NOT_FOUND', 'Segmento no encontrado.', 404);
  return rows[0];
}

function segmentSelect(segment, startAt = 1) {
  if (segment.segment_type === 'STATIC') {
    return { sql: `EXISTS (SELECT 1 FROM pedidos_app_crm_segment_members member WHERE member.segment_id=$${startAt} AND member.contact_id=contact.id)`, params: [segment.id] };
  }
  return compileSegment(segment.definition, { startAt });
}

async function segmentCount(pool, segment) {
  const compiled = segmentSelect(segment, 1);
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE contact.marketing_opt_in AND NOT contact.marketing_opt_out AND NOT contact.no_contact)::int AS eligible
    FROM pedidos_app_crm_contacts contact
    WHERE contact.deleted_at IS NULL AND ${compiled.sql}
  `, compiled.params);
  return rows[0];
}

const crmOrderIdempotencyCache = new Map();

function formatCrmOrderWhatsAppSummary({
  order,
  items = [],
  customer = {},
  restaurantName = 'Distric House',
}) {
  const isDelivery = String(order.delivery_type || customer.deliveryType || '').toLowerCase() === 'domicilio';
  const orderNumber = String(order.id || 0).padStart(4, '0');
  const lines = [
    `🍔 *${restaurantName} — Pedido Confirmado*`,
    `*Pedido #${orderNumber}*`,
    '',
    `Hola *${customer.name || order.customer_name || 'Cliente'}*, tu pedido fue registrado y ya se encuentra *${order.status || 'En preparación'}* en nuestra cocina. 👨‍🍳🔥`,
    '',
    '*🛒 Detalle del pedido:*',
  ];
  for (const it of items) {
    const qty = Number(it.quantity || it.qty || 1);
    const unitPrice = Number(it.price || 0);
    const sub = unitPrice * qty;
    lines.push(`• ${qty}x ${it.title || it.name || 'Producto'} — $${sub.toLocaleString('es-CO')}`);
    if (it.notes) {
      lines.push(`  ↳ _${it.notes}_`);
    }
  }
  lines.push('');
  lines.push(`*Modalidad:* ${isDelivery ? '🛵 A Domicilio' : '🏪 Recoger en local'}`);
  if (isDelivery && (order.address || customer.address)) {
    lines.push(`*Dirección:* ${order.address || customer.address}${order.barrio || customer.barrio ? ` (${order.barrio || customer.barrio})` : ''}`);
  }
  const paymentMethod = String(order.payment_method || customer.paymentMethod || 'efectivo').toUpperCase();
  lines.push(`*Método de Pago:* ${paymentMethod}`);
  if (order.change_required && Number(order.change_required) > 0) {
    lines.push(`*Cambio requerido:* $${Number(order.change_required).toLocaleString('es-CO')}`);
  }
  if (isDelivery && Number(order.delivery_fee) > 0) {
    lines.push(`*Domicilio:* $${Number(order.delivery_fee).toLocaleString('es-CO')}`);
  }
  lines.push(`*Total a pagar:* $${Number(order.total || 0).toLocaleString('es-CO')}`);
  if (order.tracking_url) {
    lines.push('', `🔎 *Rastrea tu pedido en tiempo real:*`, order.tracking_url);
  }
  lines.push('', `¡Muchas gracias por elegir ${restaurantName}! ❤️`);
  return lines.join('\n');
}

async function fallbackNormalizeOrderCart(client, rawCart, { activeOnly = true } = {}) {
  if (!Array.isArray(rawCart) || rawCart.length === 0 || rawCart.length > 100) {
    const error = new Error('El pedido debe contener entre 1 y 100 productos.');
    error.statusCode = 400;
    throw error;
  }
  const ids = [...new Set(rawCart.map((item) => String(item.id || item.product_id || '')).filter(Boolean))];
  const { rows } = await client.query(
    `SELECT id, title, price, category, status
     FROM pedidos_app_products
     WHERE id::text = ANY($1::text[]) AND ($2::boolean = FALSE OR status = 'Activo')`,
    [ids, activeOnly]
  );
  const products = new Map(rows.map((p) => [String(p.id), p]));
  const cart = [];
  for (const item of rawCart) {
    const p = products.get(String(item.id || item.product_id));
    if (!p) {
      const err = new Error(`El producto #${item.id || item.product_id} no existe o no está activo.`);
      err.statusCode = 400;
      throw err;
    }
    const qty = Math.max(1, Math.min(999, parseInt(item.quantity || item.qty || 1, 10)));
    cart.push({
      id: p.id,
      title: p.title,
      price: Number(p.price),
      quantity: qty,
      category: p.category,
      notes: cleanText(item.notes, 255) || undefined,
    });
  }
  return {
    cart,
    total: cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
  };
}

function fallbackValidateOrderPayment({ paymentMethod, cashAmount, cashSplit, transferSplit, orderTotal }) {
  const method = String(paymentMethod || '').trim().toLowerCase();
  if (!['efectivo', 'transferencia', 'compartido'].includes(method)) {
    return {
      isValid: false,
      error: `Método de pago no válido: '${paymentMethod}'. Valores permitidos: efectivo, transferencia, compartido.`,
    };
  }
  if (method === 'efectivo') {
    const cash = Number(cashAmount);
    if (Number.isFinite(cash) && cash > 0 && cash < orderTotal) {
      return {
        isValid: false,
        error: `El efectivo indicado ($${cash.toLocaleString('es-CO')}) no cubre el total de $${orderTotal.toLocaleString('es-CO')}.`,
      };
    }
  }
  if (method === 'compartido') {
    const c = Number(cashSplit) || 0;
    const t = Number(transferSplit) || 0;
    if (c + t < orderTotal) {
      return {
        isValid: false,
        error: `La suma de pago compartido ($${(c + t).toLocaleString('es-CO')}) no cubre el total de $${orderTotal.toLocaleString('es-CO')}.`,
      };
    }
  }
  return { isValid: true, method };
}

async function fallbackReserveProductStock() {
  return 0;
}

module.exports = function registerCrmApi(app, {
  pool,
  authenticateToken,
  requirePermission,
  whatsappClient,
  crmWorker = null,
  normalizeOrderCart = null,
  reserveProductStock = null,
  deliveryOrderService = null,
  validateOrderPayment = null,
  issueTrackingToken = null,
  JWT_SECRET = null,
  getHorariosStatus = null,
}) {
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'WHATSAPP_WEBHOOK_RATE_LIMIT', error: 'Límite temporal de webhooks alcanzado.' },
  });
  const sendLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'CRM_SEND_RATE_LIMIT', error: 'Demasiados envíos en un minuto.' },
  });
  const campaignLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'CRM_CAMPAIGN_RATE_LIMIT', error: 'Demasiadas operaciones de campaña en un minuto.' },
  });
  const exportLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'CRM_EXPORT_RATE_LIMIT', error: 'Demasiadas exportaciones en un minuto.' },
  });

  const requireWebhookHttps = (req, res, next) => {
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const production = process.env.NODE_ENV === 'production'
      || process.env.RENDER === 'true'
      || Boolean(process.env.RENDER_SERVICE_ID);
    if (!production || req.secure || forwardedProtocol === 'https') return next();
    console.warn(JSON.stringify({
      level: 'warn',
      component: 'whatsapp-webhook',
      event: 'webhook_https_rejected',
      request_id: req.requestId || null,
      forwarded_proto: forwardedProtocol || null,
    }));
    return res.status(426).json({
      code: 'WHATSAPP_WEBHOOK_HTTPS_REQUIRED',
      error: 'El webhook de WhatsApp solo está disponible mediante HTTPS en producción.',
    });
  };

  const logWebhookPayload = (req) => {
    if (String(process.env.WHATSAPP_WEBHOOK_LOG_PAYLOAD || 'true').toLowerCase() === 'false') return;
    const body = req.body || {};
    const msg = body.whatsappInboundMessage
      || body.whatsappMessage
      || body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      || null;
    const statusObj = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0] || null;
    console.log(JSON.stringify({
      level: 'info',
      component: 'whatsapp-webhook',
      event: 'payload_received',
      request_id: req.requestId || null,
      webhook_id: body.id || body.entry?.[0]?.id || null,
      webhook_type: body.type || body.object || 'unknown',
      message_id: msg?.id || msg?.wamid || statusObj?.id || null,
      message_type: msg?.type || (statusObj ? `status:${statusObj.status}` : null),
      sender_masked: maskIdentifier(msg?.from || msg?.fromUserId || null),
      recipient_masked: maskIdentifier(msg?.to || msg?.toUserId || statusObj?.recipient_id || null),
      create_time: body.createTime || msg?.sendTime || msg?.timestamp || null,
    }));
  };

  app.get('/api/pedidos/webhooks/whatsapp', requireWebhookHttps, webhookLimiter, (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const validTokens = [
      whatsappClient.config.verifyToken,
      process.env.YCLOUD_WEBHOOK_SECRET,
      process.env.WHATSAPP_VERIFY_TOKEN,
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      'whsec_4ad302be242b4c73b4b74793b07667aa',
    ].filter(Boolean);
    if (mode === 'subscribe' && validTokens.includes(token)) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.status(403).json({ code: 'WHATSAPP_WEBHOOK_VERIFICATION_FAILED', error: 'No fue posible verificar el webhook.' });
  });

  app.post('/api/pedidos/webhooks/whatsapp', requireWebhookHttps, webhookLimiter, async (req, res) => {
    try {
      const signature = req.headers['ycloud-signature'] || req.headers['x-hub-signature-256'];
      const effectiveRawBody = req.rawBody || (req.body && typeof req.body === 'object' && Object.keys(req.body).length ? Buffer.from(JSON.stringify(req.body), 'utf8') : null);
      if (!validateWebhookSignature(effectiveRawBody, signature, whatsappClient.config.verifyToken)) {
        const sigMeta = describeWebhookSignature(signature);
        console.warn(JSON.stringify({
          level: 'warn',
          component: 'whatsapp-webhook',
          event: 'webhook_signature_rejected',
          request_id: req.requestId || null,
          signature_format: sigMeta.format,
          signature_timestamp: sigMeta.timestamp,
          has_raw_body: Boolean(effectiveRawBody),
          webhook_type: req.body?.type || req.body?.object || null,
        }));
        return res.status(401).json({ code: 'WHATSAPP_WEBHOOK_SIGNATURE_INVALID', error: 'Firma de webhook de YCloud/Meta inválida.' });
      }
      logWebhookPayload(req);

      const regPromise = registerWhatsAppWebhook(pool, req.body, effectiveRawBody);
      let timeoutHandle = null;
      const raceResult = await Promise.race([
        regPromise.then((reg) => ({ timedOut: false, reg })),
        new Promise((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ timedOut: true, reg: null }), 1800);
          if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const response = res.status(200).json({
        status: 'accepted',
        duplicate: raceResult.reg ? raceResult.reg.duplicate : false,
      });
      setImmediate(() => {
        void regPromise
          .then((registration) => processStoredWhatsAppWebhook(pool, registration.eventKey).then((result) => ({ registration, result })))
          .then(({ registration, result }) => console.log(JSON.stringify({
            level: 'info', component: 'whatsapp-webhook-worker', event: 'payload_processed',
            request_id: req.requestId || null, event_key: registration.eventKey,
            event_type: registration.eventType || null,
            duplicate: result.duplicate, processed: result.processed,
          })))
          .catch((error) => console.error(JSON.stringify({
            level: 'error', component: 'whatsapp-webhook-worker', event: 'payload_failed',
            request_id: req.requestId || null,
            code: error.code || 'WHATSAPP_WEBHOOK_PROCESSING_FAILED', message: error.message,
          })));
      });
      return response;
    } catch (error) { return respondError(res, error); }
  });

  app.get('/api/pedidos/admin/crm/dashboard', authenticateToken, requirePermission('CRM','ver'), async (req, res) => {
    try {
      const [summary, funnel, sources, activity, campaigns] = await Promise.all([
        pool.query(`
          SELECT COUNT(*)::int AS contacts,
            COUNT(*) FILTER (WHERE status IN ('NUEVO_CONTACTO','PROSPECTO'))::int AS prospects,
            COUNT(*) FILTER (WHERE status IN ('CLIENTE_NUEVO','CLIENTE_RECURRENTE','CLIENTE_FRECUENTE','VIP','RECUPERADO'))::int AS customers,
            COUNT(*) FILTER (WHERE status IN ('CLIENTE_RECURRENTE','CLIENTE_FRECUENTE','VIP','RECUPERADO'))::int AS recurring,
            COUNT(*) FILTER (WHERE status='VIP')::int AS vip,
            COUNT(*) FILTER (WHERE status='INACTIVO')::int AS inactive,
            COALESCE(SUM(total_spent),0)::bigint AS lifetime_value,
            COUNT(*) FILTER (WHERE marketing_opt_in AND NOT marketing_opt_out AND NOT no_contact)::int AS marketable
          FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL
        `),
        pool.query(`SELECT status,COUNT(*)::int AS count FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC`),
        pool.query(`SELECT source,COUNT(*)::int AS count FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL GROUP BY source ORDER BY count DESC LIMIT 10`),
        pool.query(`
          SELECT activity.*,contact.display_name FROM pedidos_app_crm_activities activity
          LEFT JOIN pedidos_app_crm_contacts contact ON contact.id=activity.contact_id
          ORDER BY activity.occurred_at DESC,activity.id DESC LIMIT 12
        `),
        pool.query(`
          SELECT COUNT(*) FILTER (WHERE status IN ('RUNNING','SCHEDULED'))::int AS active_campaigns,
            COALESCE(SUM(attributed_revenue),0)::bigint AS attributed_revenue,
            COALESCE(SUM(converted_count),0)::int AS conversions,
            COALESCE(SUM(sent_count),0)::int AS sent
          FROM pedidos_app_crm_campaigns
        `),
      ]);
      const conversations = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE created_at >= date_trunc('day',NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota')::int AS today,
          COUNT(*) FILTER (WHERE status IN ('OPEN','PENDING') AND unread_count>0)::int AS unanswered
        FROM pedidos_app_crm_conversations
      `);
      const campaign = campaigns.rows[0];
      const conversionRate = campaign.sent ? Number(((campaign.conversions / campaign.sent) * 100).toFixed(1)) : 0;
      res.json({ status: 'ok', summary: { ...summary.rows[0], ...conversations.rows[0], ...campaign, conversion_rate: conversionRate }, funnel: funnel.rows, sources: sources.rows, activity: activity.rows });
    } catch (error) { respondError(res, error); }
  });

  app.get('/api/pedidos/admin/crm/contacts', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try {
      const page = positiveInteger(req.query.page, 1, 1_000_000);
      const limit = positiveInteger(req.query.limit, 25, 100);
      const filters = contactFilters(req.query);
      const params = [...filters.values, limit, (page - 1) * limit];
      const { rows } = await pool.query(`
        SELECT contact.*,COALESCE(tags.tags,'[]'::jsonb) AS tags,
          COUNT(*) OVER()::int AS filtered_count
        FROM pedidos_app_crm_contacts contact
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color) ORDER BY tag.name) AS tags
          FROM pedidos_app_crm_contact_tags link JOIN pedidos_app_crm_tags tag ON tag.id=link.tag_id WHERE link.contact_id=contact.id
        ) tags ON TRUE
        WHERE ${CONTACT_FILTER_SQL}
        ORDER BY contact.last_contact_at DESC NULLS LAST,contact.last_purchase_at DESC NULLS LAST,contact.id DESC
        LIMIT $10 OFFSET $11
      `, params);
      const total = rows[0]?.filtered_count || 0;
      res.json({ status: 'ok', contacts: rows.map(({ filtered_count, ...row }) => row), pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (error) { respondError(res, error); }
  });

  app.get('/api/pedidos/admin/crm/contacts/:id', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try {
      const contactResult = await pool.query(`
        SELECT contact.*,assigned.name AS assigned_name,assigned.last_name AS assigned_last_name,
          COALESCE(tags.tags,'[]'::jsonb) AS tags
        FROM pedidos_app_crm_contacts contact
        LEFT JOIN pedidos_app_users assigned ON assigned.id=contact.assigned_user_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color) ORDER BY tag.name) AS tags
          FROM pedidos_app_crm_contact_tags link JOIN pedidos_app_crm_tags tag ON tag.id=link.tag_id WHERE link.contact_id=contact.id
        ) tags ON TRUE
        WHERE contact.id=$1 AND contact.deleted_at IS NULL
      `, [req.params.id]);
      if (!contactResult.rows.length) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto no encontrado.', 404);
      const [orders, conversations, notes, activity, interests, consents, customers, favoriteProducts] = await Promise.all([
        pool.query(`SELECT id,status,total,source,delivery_type,payment_method,address,barrio,notes,delivery_fee,created_at,delivered_at,cart_json FROM pedidos_app_orders WHERE crm_contact_id=$1 ORDER BY created_at DESC LIMIT 250`, [req.params.id]),
        pool.query(`SELECT * FROM pedidos_app_crm_conversations WHERE contact_id=$1 ORDER BY last_message_at DESC NULLS LAST LIMIT 50`, [req.params.id]),
        pool.query(`SELECT note.*,creator.name AS creator_name FROM pedidos_app_crm_notes note LEFT JOIN pedidos_app_users creator ON creator.id=note.created_by WHERE note.contact_id=$1 AND note.deleted_at IS NULL ORDER BY note.created_at DESC`, [req.params.id]),
        pool.query(`SELECT * FROM pedidos_app_crm_activities WHERE contact_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 200`, [req.params.id]),
        pool.query(`SELECT * FROM pedidos_app_crm_contact_interests WHERE contact_id=$1 ORDER BY score DESC,created_at DESC`, [req.params.id]),
        pool.query(`SELECT id,channel,consent_type,granted,source,occurred_at,actor_user_id FROM pedidos_app_crm_consents WHERE contact_id=$1 ORDER BY occurred_at DESC LIMIT 50`, [req.params.id]),
        pool.query(`SELECT customer.id,customer.name,customer.phone,customer.email,customer.status FROM pedidos_app_crm_contact_customers link JOIN pedidos_app_customers customer ON customer.id=link.customer_id WHERE link.contact_id=$1`, [req.params.id]),
        pool.query(`
          SELECT item->>'title' AS product,
            SUM(GREATEST(COALESCE((item->>'quantity')::int,1),1))::int AS quantity,
            COUNT(DISTINCT order_data.id)::int AS orders
          FROM pedidos_app_orders order_data
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(order_data.cart_json,'[]'::jsonb)) item
          WHERE order_data.crm_contact_id=$1 AND order_data.status NOT IN ('Cancelado','Rechazado')
            AND NULLIF(item->>'title','') IS NOT NULL
          GROUP BY item->>'title' ORDER BY quantity DESC,orders DESC,product LIMIT 8
        `, [req.params.id]),
      ]);
      res.json({ status: 'ok', contact: contactResult.rows[0], orders: orders.rows, conversations: conversations.rows, notes: notes.rows, activity: activity.rows, interests: interests.rows, consents: consents.rows, customers: customers.rows, favorite_products: favoriteProducts.rows });
    } catch (error) { respondError(res, error); }
  });

  app.put('/api/pedidos/admin/crm/contacts/:id', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    const client = await pool.connect();
    try {
      const status = CONTACT_STATUSES.has(req.body.status) ? req.body.status : null;
      const source = SOURCES.has(req.body.source) ? req.body.source : null;
      const assigned = req.body.assigned_user_id === null || req.body.assigned_user_id === '' ? null : Number(req.body.assigned_user_id);
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE pedidos_app_crm_contacts SET display_name=$2,email=$3,address=$4,barrio=$5,
          status=COALESCE($6,status),source=COALESCE($7,source),assigned_user_id=$8,updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL RETURNING *
      `, [req.params.id, cleanText(req.body.display_name,255) || null, cleanText(req.body.email,255) || null,
        cleanText(req.body.address,1000) || null, cleanText(req.body.barrio,255) || null, status, source,
        Number.isInteger(assigned) && assigned > 0 ? assigned : null]);
      if (!rows.length) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto no encontrado.', 404);
      await client.query(`INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,actor_user_id,summary,metadata) VALUES ($1,'CONTACT_UPDATED','CRM_CONTACT',$1::text,$2,'Perfil CRM actualizado',$3::jsonb)`, [req.params.id, req.user.id, JSON.stringify({ status, source, assignedUserId: assigned })]);
      await audit(client, req, 'CONTACT_UPDATED', 'crm_contact', req.params.id, { status, source, assignedUserId: assigned });
      await appendCrmEvent(client, 'crm.contact.updated', 'crm_contact', req.params.id, { contactId: Number(req.params.id) });
      await client.query('COMMIT');
      res.json({ status: 'ok', contact: rows[0] });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); respondError(res, error); }
    finally { client.release(); }
  });

  app.post('/api/pedidos/admin/crm/contacts/:id/consent', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    const client = await pool.connect();
    try {
      const granted = req.body.granted === true;
      const source = cleanText(req.body.source,60) || 'ADMIN_EXPLICIT';
      await client.query('BEGIN');
      const contact = await client.query(`
        UPDATE pedidos_app_crm_contacts SET marketing_opt_in=$2,marketing_opt_out=NOT $2,
          no_contact=CASE WHEN $2 THEN FALSE ELSE TRUE END,opt_out_reason=CASE WHEN $2 THEN NULL ELSE $3 END,
          status=CASE WHEN NOT $2 THEN 'NO_CONTACTAR' ELSE status END,updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL RETURNING *
      `, [req.params.id, granted, cleanText(req.body.reason,500) || null]);
      if (!contact.rows.length) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto no encontrado.', 404);
      await client.query(`
        INSERT INTO pedidos_app_crm_consents (contact_id,channel,consent_type,granted,source,evidence,actor_user_id)
        VALUES ($1,'WHATSAPP','MARKETING',$2,$3,$4::jsonb,$5)
      `, [req.params.id, granted, source, JSON.stringify({ reason: cleanText(req.body.reason,500) || null }), req.user.id]);
      await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [req.params.id]);
      await audit(client, req, granted ? 'CONSENT_GRANTED' : 'OPT_OUT', 'crm_contact', req.params.id, { source });
      await appendCrmEvent(client, 'crm.consent.updated', 'crm_contact', req.params.id, { contactId: Number(req.params.id), granted });
      await client.query('COMMIT');
      res.json({ status: 'ok', contact: contact.rows[0] });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); respondError(res, error); }
    finally { client.release(); }
  });

  app.post('/api/pedidos/admin/crm/contacts/:id/notes', authenticateToken, requirePermission('CRM','notas'), async (req, res) => {
    const client = await pool.connect();
    try {
      const body = cleanText(req.body.body,5000);
      if (!body) throw crmError('CRM_NOTE_EMPTY', 'La nota no puede estar vacía.', 400);
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO pedidos_app_crm_notes (contact_id,body,is_sensitive,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$4) RETURNING *
      `, [req.params.id, body, Boolean(req.body.is_sensitive), req.user.id]);
      await audit(client,req,Boolean(req.body.is_sensitive)?'SENSITIVE_NOTE_CREATED':'NOTE_CREATED','crm_note',rows[0].id,{contactId:Number(req.params.id)});
      await client.query('COMMIT');
      res.status(201).json({ status: 'ok', note: rows[0] });
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); respondError(res, error); }
    finally { client.release(); }
  });

  app.post('/api/pedidos/admin/crm/contacts/:id/tags', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try {
      await pool.query(`INSERT INTO pedidos_app_crm_contact_tags (contact_id,tag_id,assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, req.body.tag_id, req.user.id]);
      res.json({ status: 'ok' });
    } catch (error) { respondError(res, error); }
  });

  app.delete('/api/pedidos/admin/crm/contacts/:id/tags/:tagId', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try { await pool.query('DELETE FROM pedidos_app_crm_contact_tags WHERE contact_id=$1 AND tag_id=$2', [req.params.id, req.params.tagId]); res.json({ status: 'ok' }); }
    catch (error) { respondError(res, error); }
  });

  app.get('/api/pedidos/admin/crm/tags', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try { const { rows } = await pool.query(`SELECT tag.*,COUNT(link.contact_id)::int AS contacts_count FROM pedidos_app_crm_tags tag LEFT JOIN pedidos_app_crm_contact_tags link ON link.tag_id=tag.id GROUP BY tag.id ORDER BY tag.name`); res.json({ status: 'ok', tags: rows }); }
    catch (error) { respondError(res, error); }
  });

  app.post('/api/pedidos/admin/crm/tags', authenticateToken, requirePermission('CRM','contactos'), async (req, res) => {
    try {
      const name = cleanText(req.body.name,80); if (!name) throw crmError('CRM_TAG_INVALID','El nombre de la etiqueta es obligatorio.',400);
      const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#D4A017';
      const { rows } = await pool.query(`INSERT INTO pedidos_app_crm_tags (name,color,description,created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [name,color,cleanText(req.body.description,300)||null,req.user.id]);
      res.status(201).json({ status:'ok',tag:rows[0] });
    } catch (error) { respondError(res,error); }
  });

  app.get('/api/pedidos/admin/crm/conversations', authenticateToken, requirePermission('CRM','conversaciones'), async (req, res) => {
    try {
      const page = positiveInteger(req.query.page, 1, 1_000_000);
      const limit = positiveInteger(req.query.limit, 60, 200);
      const rawStatus = String(req.query.status || '').toUpperCase();
      const status = ['OPEN','PENDING','CLOSED'].includes(rawStatus) ? rawStatus : '';
      const unreadOnly = rawStatus === 'UNREAD' || req.query.unread === 'true';
      const chatsOnly = rawStatus === 'CHATS' || req.query.only_chats === 'true';
      const contactId = /^\d+$/.test(String(req.query.contact_id || '')) ? Number(req.query.contact_id) : null;
      const search = cleanText(req.query.search, 160);
      const { rows } = await pool.query(`
        SELECT conversation.*,
          contact.display_name,contact.normalized_phone,contact.bsuid,contact.username,
          contact.status AS contact_status,contact.orders_count,contact.total_spent,
          contact.last_purchase_at,contact.barrio,contact.address,
          assigned.name AS assigned_name,
          last_message.message_id AS last_message_id,
          last_message.text_body AS last_message_text,
          last_message.message_type AS last_message_type,
          last_message.direction AS last_message_direction,
          last_message.status AS last_message_status,
          last_message.sent_by AS last_message_sent_by,
          last_message.created_at AS last_message_created_at,
          GREATEST(last_message.created_at, conversation.last_inbound_at, conversation.last_message_at) AS effective_last_message_at,
          COUNT(*) OVER()::int AS filtered_count
        FROM pedidos_app_crm_conversations conversation
        JOIN pedidos_app_crm_contacts contact ON contact.id=conversation.contact_id
        LEFT JOIN pedidos_app_users assigned ON assigned.id=conversation.assigned_user_id
        LEFT JOIN LATERAL (
          SELECT id AS message_id,text_body,message_type,direction,status,sent_by,created_at
          FROM pedidos_app_crm_messages
          WHERE conversation_id=conversation.id
          ORDER BY created_at DESC,id DESC LIMIT 1
        ) last_message ON TRUE
        WHERE contact.deleted_at IS NULL
          AND ($1='' OR conversation.status=$1)
          AND (NOT $5::boolean OR conversation.unread_count > 0)
          AND ($6::bigint IS NULL OR conversation.contact_id=$6)
          AND (NOT $7::boolean OR conversation.last_inbound_at IS NOT NULL OR conversation.unread_count > 0 OR last_message.sent_by IS NOT NULL OR (last_message.message_type IS NOT NULL AND last_message.message_type <> 'template'))
          AND ($2='%%'
            OR contact.display_name ILIKE $2
            OR contact.normalized_phone ILIKE $2
            OR contact.username ILIKE $2
            OR contact.bsuid ILIKE $2
            OR EXISTS (
              SELECT 1 FROM pedidos_app_crm_messages msg_search
              WHERE msg_search.conversation_id=conversation.id AND msg_search.text_body ILIKE $2
            ))
        ORDER BY
          CASE
            WHEN conversation.last_inbound_at IS NOT NULL OR conversation.unread_count > 0 OR last_message.sent_by IS NOT NULL OR (last_message.message_type IS NOT NULL AND last_message.message_type <> 'template') OR last_message.message_id IS NULL THEN 0
            ELSE 1
          END ASC,
          GREATEST(last_message.created_at, conversation.last_inbound_at, conversation.last_message_at) DESC NULLS LAST,
          conversation.id DESC
        LIMIT $3 OFFSET $4
      `, [status, `%${search}%`, limit, (page - 1) * limit, unreadOnly, contactId, chatsOnly]);
      const total = rows[0]?.filtered_count || 0;
      res.json({
        status: 'ok',
        conversations: rows.map(({ filtered_count, effective_last_message_at, ...row }) => ({
          ...row,
          last_message_at: effective_last_message_at || row.last_message_at,
        })),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (error) { respondError(res, error); }
  });

  app.post('/api/pedidos/admin/crm/conversations/open', authenticateToken, requirePermission('CRM','conversaciones'), async (req, res) => {
    const client = await pool.connect();
    try {
      const contactId = Number(req.body.contact_id);
      if (!Number.isInteger(contactId) || contactId <= 0) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto inválido.', 400);
      await client.query('BEGIN');
      const contactCheck = await client.query('SELECT id FROM pedidos_app_crm_contacts WHERE id=$1 AND deleted_at IS NULL', [contactId]);
      if (!contactCheck.rows.length) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto no encontrado.', 404);
      const conv = await ensureConversation(client, {
        contactId,
        providerAccountId: whatsappClient.config.phoneNumberId || null,
      });
      await client.query('COMMIT');
      res.json({ status: 'ok', conversation: conv });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      respondError(res, error);
    } finally { client.release(); }
  });

  app.get('/api/pedidos/admin/crm/conversations/:id', authenticateToken, requirePermission('CRM','conversaciones'), async (req, res) => {
    try {
      const conversation = await pool.query(`
        SELECT conversation.*,
          contact.display_name,contact.normalized_phone,contact.bsuid,contact.username,
          contact.status AS contact_status,contact.orders_count,contact.total_spent,
          contact.average_ticket,contact.last_purchase_at,contact.first_purchase_at,
          contact.address,contact.barrio,contact.email,contact.source AS contact_source,
          contact.marketing_opt_in,contact.marketing_opt_out,contact.no_contact,
          COALESCE(tags.tags,'[]'::jsonb) AS contact_tags
        FROM pedidos_app_crm_conversations conversation
        JOIN pedidos_app_crm_contacts contact ON contact.id=conversation.contact_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color) ORDER BY tag.name) AS tags
          FROM pedidos_app_crm_contact_tags link JOIN pedidos_app_crm_tags tag ON tag.id=link.tag_id WHERE link.contact_id=contact.id
        ) tags ON TRUE
        WHERE conversation.id=$1
      `, [req.params.id]);
      if (!conversation.rows.length) throw crmError('CONVERSATION_NOT_FOUND', 'Conversación no encontrada.', 404);
      const convRow = conversation.rows[0];
      const before = /^\d+$/.test(String(req.query.before || '')) ? Number(req.query.before) : null;
      const after = /^\d+$/.test(String(req.query.after || '')) ? Number(req.query.after) : null;
      const [messages, orders, notes] = await Promise.all([
        pool.query(`
          SELECT * FROM pedidos_app_crm_messages
          WHERE conversation_id=$1
            AND ($2::bigint IS NULL OR id<$2)
            AND ($3::bigint IS NULL OR id>$3)
          ORDER BY created_at DESC, id DESC LIMIT 100
        `, [req.params.id, before, after]),
        pool.query(`
          SELECT id,status,total,source,delivery_type,payment_method,address,barrio,notes,delivery_fee,created_at,delivered_at,cart_json
          FROM pedidos_app_orders
          WHERE crm_contact_id=$1
          ORDER BY created_at DESC LIMIT 50
        `, [convRow.contact_id]),
        pool.query(`
          SELECT note.*,creator.name AS creator_name
          FROM pedidos_app_crm_notes note
          LEFT JOIN pedidos_app_users creator ON creator.id=note.created_by
          WHERE note.contact_id=$1 AND note.deleted_at IS NULL
          ORDER BY note.created_at DESC LIMIT 20
        `, [convRow.contact_id]),
      ]);
      res.json({
        status: 'ok',
        conversation: convRow,
        messages: messages.rows.reverse(),
        orders: orders.rows,
        notes: notes.rows,
      });
    } catch (error) { respondError(res, error); }
  });

  app.post('/api/pedidos/admin/crm/conversations/:id/read', authenticateToken, requirePermission('CRM','conversaciones'), async(req,res)=>{
    try{await pool.query(`UPDATE pedidos_app_crm_conversations SET unread_count=0,updated_at=NOW() WHERE id=$1`,[req.params.id]);res.json({status:'ok'});}catch(error){respondError(res,error);}
  });

  app.put('/api/pedidos/admin/crm/conversations/:id', authenticateToken, requirePermission('CRM','conversaciones'), async(req,res)=>{
    const client=await pool.connect();try{
      const status=['OPEN','PENDING','CLOSED'].includes(req.body.status)?req.body.status:null;
      const assigned=req.body.assigned_user_id===null?null:Number(req.body.assigned_user_id);
      await client.query('BEGIN'); const {rows}=await client.query(`UPDATE pedidos_app_crm_conversations SET status=COALESCE($2,status),assigned_user_id=$3,closed_at=CASE WHEN $2='CLOSED' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,status,Number.isInteger(assigned)&&assigned>0?assigned:null]);
      if(!rows.length) throw crmError('CONVERSATION_NOT_FOUND','Conversación no encontrada.',404);
      await audit(client,req,'CONVERSATION_UPDATED','crm_conversation',req.params.id,{status,assignedUserId:assigned}); await appendCrmEvent(client,'crm.assignment.updated','crm_conversation',req.params.id,{conversationId:Number(req.params.id),assignedUserId:assigned}); await client.query('COMMIT');res.json({status:'ok',conversation:rows[0]});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.post('/api/pedidos/admin/crm/conversations/:id/messages', authenticateToken, requirePermission('CRM','responder'), sendLimiter, async(req,res)=>{
    try{
      const result=await queueConversationMessage(pool,{conversationId:req.params.id,actorUserId:req.user.id,text:req.body.text,template:req.body.template,idempotencyKey:req.headers['idempotency-key']});
      setImmediate(() => { void crmWorker?.processOne?.(); });
      res.status(result.duplicate?200:202).json({status:'ok',...result});
    }catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/conversations/:id/orders', authenticateToken, requirePermission('CRM', 'responder'), async (req, res) => {
    try {
      const idempotencyKey = cleanText(req.headers['idempotency-key'] || req.body.idempotencyKey, 180);
      if (idempotencyKey && crmOrderIdempotencyCache.has(idempotencyKey)) {
        const cached = crmOrderIdempotencyCache.get(idempotencyKey);
        return res.status(200).json({ status: 'ok', duplicate: true, ...cached });
      }

      const convRes = await pool.query(`
        SELECT conversation.*, contact.id AS c_id, contact.display_name, contact.normalized_phone,
               contact.bsuid, contact.address, contact.barrio, contact.no_contact, contact.marketing_opt_out,
               contact.deleted_at
        FROM pedidos_app_crm_conversations conversation
        JOIN pedidos_app_crm_contacts contact ON contact.id = conversation.contact_id
        WHERE conversation.id = $1
      `, [req.params.id]);

      if (!convRes.rows.length) throw crmError('CONVERSATION_NOT_FOUND', 'Conversación no encontrada.', 404);
      const conv = convRes.rows[0];

      if (conv.deleted_at && !String(conv.bsuid || '').startsWith('MERGED:')) {
        await pool.query('UPDATE pedidos_app_crm_contacts SET deleted_at=NULL WHERE id=$1', [conv.c_id]).catch(() => {});
      }

      const customer = req.body.customer || {};
      const customerName = cleanText(customer.name || conv.display_name, 120) || 'Cliente WhatsApp';
      const rawDt = String(customer.deliveryType || req.body.deliveryType || 'domicilio').toLowerCase().trim();
      const customerDeliveryType = (rawDt === 'tienda' || rawDt === 'recoger') ? 'recoger' : (rawDt === 'presencial' || rawDt === 'mostrador') ? 'presencial' : 'domicilio';
      const isDelivery = customerDeliveryType === 'domicilio';
      const orderAddress = cleanText(customer.address || conv.address, 255);
      const orderBarrio = cleanText(customer.barrio || conv.barrio, 120);
      const deliveryReference = cleanText(customer.reference || customer.delivery_reference, 255);
      const customerPaymentMethod = String(customer.paymentMethod || req.body.paymentMethod || 'efectivo').toLowerCase().trim();

      if (isDelivery && !orderAddress) {
        throw crmError('DELIVERY_ADDRESS_REQUIRED', 'La dirección de entrega es obligatoria para pedidos a domicilio.', 400);
      }

      const rawCart = Array.isArray(req.body.cart) ? req.body.cart : [];
      if (!rawCart.length) {
        throw crmError('CART_EMPTY', 'El pedido debe contener al menos un producto.', 400);
      }

      const client = await pool.connect();
      let createdOrder;
      let normalized;
      let deliveryFee = 0;
      let orderTotal = 0;
      let paymentCheck;
      let finalStatus;
      let changeRequired = null;

      try {
        const effectiveNormalizeCart = normalizeOrderCart || fallbackNormalizeOrderCart;
        normalized = await effectiveNormalizeCart(client, rawCart);
        if (!normalized.cart || !normalized.cart.length) {
          throw crmError('CART_EMPTY', 'El pedido debe contener al menos un producto válido.', 400);
        }

        if (isDelivery) {
          const settingsResult = await client.query('SELECT COALESCE(delivery_cost, 0)::integer AS delivery_cost FROM pedidos_app_settings WHERE id = 1');
          deliveryFee = Math.max(0, Number(settingsResult.rows[0]?.delivery_cost || 0));
        }
        orderTotal = normalized.total + deliveryFee;

        const effectiveValidatePayment = validateOrderPayment || fallbackValidateOrderPayment;
        paymentCheck = effectiveValidatePayment({
          paymentMethod: customerPaymentMethod,
          cashAmount: customer.cashAmount !== undefined ? customer.cashAmount : req.body.cashAmount,
          cashSplit: customer.cash_split !== undefined ? customer.cash_split : req.body.cash_split,
          transferSplit: customer.transfer_split !== undefined ? customer.transfer_split : req.body.transfer_split,
          orderTotal,
        });
        if (!paymentCheck.isValid) {
          throw crmError('PAYMENT_INVALID', paymentCheck.error, 400);
        }

        // Deduplicación en ventana corta de 60 segundos por si no enviaron idempotencyKey
        const recentDuplicate = await client.query(`
          SELECT id, created_at, status, total, delivery_fee, cart_json, customer_name, customer_phone, address, barrio, delivery_type, payment_method, change_required
          FROM pedidos_app_orders
          WHERE crm_contact_id = $1 AND (source = 'WhatsApp' OR source = 'WhatsApp CRM') AND total = $2
            AND created_at >= NOW() - INTERVAL '60 seconds'
          ORDER BY id DESC LIMIT 1
        `, [conv.contact_id, orderTotal]);

        if (recentDuplicate.rows.length > 0 && JSON.stringify(recentDuplicate.rows[0].cart_json) === JSON.stringify(normalized.cart)) {
          const prev = recentDuplicate.rows[0];
          client.release();
          return res.status(200).json({
            status: 'ok',
            duplicate: true,
            order: {
              id: prev.id,
              customer_name: prev.customer_name,
              customer_phone: prev.customer_phone,
              address: prev.address,
              barrio: prev.barrio,
              delivery_type: prev.delivery_type,
              payment_method: prev.payment_method,
              total: Number(prev.total),
              subtotal: normalized.total,
              delivery_fee: Number(prev.delivery_fee),
              change_required: prev.change_required ? Number(prev.change_required) : null,
              status: prev.status,
              cart_json: prev.cart_json,
              created_at: prev.created_at,
            },
            whatsapp: { status: 'duplicate_prevented', message: 'Pedido recuperado de la solicitud anterior idéntica.' },
          });
        }

        await client.query('BEGIN');
        finalStatus = req.body.sendToKitchen !== false ? 'En preparación' : 'Nuevo';
        changeRequired = paymentCheck.method === 'efectivo' && Number(customer.cashAmount) >= orderTotal
          ? Math.round(Number(customer.cashAmount) - orderTotal)
          : null;
        const finalNotes = cleanText(customer.notes || req.body.notes, 500);
        const voucherRef = cleanText(customer.voucher_reference || req.body.voucher_reference, 120);

        const { rows: orderRows } = await client.query(`
          INSERT INTO pedidos_app_orders
            (customer_name, customer_phone, address, barrio, delivery_type, payment_method,
             total, cart_json, source, notes, voucher_reference, delivery_fee, change_required,
             delivery_reference, status, crm_contact_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'WhatsApp', $9, $10, $11, $12, $13, $14, $15, NOW())
          RETURNING id, created_at, status, total, delivery_fee
        `, [
          customerName,
          customerPhone || null,
          orderAddress || '',
          orderBarrio || '',
          customerDeliveryType,
          paymentCheck.method,
          orderTotal,
          JSON.stringify(normalized.cart),
          finalNotes || '',
          voucherRef || '',
          deliveryFee,
          changeRequired,
          deliveryReference || '',
          finalStatus,
          conv.contact_id,
        ]);
        createdOrder = orderRows[0];

        const effectiveReserveStock = reserveProductStock || fallbackReserveProductStock;
        await effectiveReserveStock(client, normalized, createdOrder.id, 'WhatsApp');

        await client.query('SELECT pedidos_app_crm_refresh_contact($1::bigint)', [conv.contact_id]).catch(() => {});

        if (deliveryOrderService?.appendDomainEvent) {
          await deliveryOrderService.appendDomainEvent(client, 'order_created', 'order', createdOrder.id, {
            orderId: createdOrder.id,
            orderStatus: finalStatus,
            source: 'WhatsApp',
            deliveryType: customerDeliveryType,
            total: orderTotal,
            conversationId: conv.id,
            contactId: conv.contact_id,
          });
        } else {
          await appendCrmEvent(client, 'order_created', 'order', createdOrder.id, {
            orderId: createdOrder.id,
            orderStatus: finalStatus,
            source: 'WhatsApp',
            deliveryType: customerDeliveryType,
            total: orderTotal,
          });
        }

        const orderMsgText = `Pedido #${createdOrder.id} registrado (${finalStatus}) — Total: $${orderTotal.toLocaleString('es-CO')}`;
        const orderContent = {
          order_id: createdOrder.id,
          total: orderTotal,
          subtotal: normalized.total,
          delivery_fee: deliveryFee,
          status: finalStatus,
          delivery_type: customerDeliveryType,
          payment_method: paymentCheck.method,
          items: normalized.cart,
        };
        const orderMsgRes = await client.query(`
          INSERT INTO pedidos_app_crm_messages
            (conversation_id, contact_id, direction, message_type, text_body, content, status, sent_by, created_at)
          VALUES ($1, $2, 'OUTBOUND', 'order', $3, $4::jsonb, 'DELIVERED', $5, NOW())
          RETURNING id, created_at
        `, [conv.id, conv.contact_id, orderMsgText, JSON.stringify(orderContent), req.user?.id || null]);

        await appendCrmEvent(client, 'crm.message.received', 'crm_conversation', conv.id, {
          conversationId: conv.id,
          contactId: conv.contact_id,
          messageId: orderMsgRes.rows[0].id,
          orderId: createdOrder.id,
        });

        await audit(client, req, 'CRM_ORDER_CREATED', 'order', createdOrder.id, {
          conversationId: conv.id,
          contactId: conv.contact_id,
          total: orderTotal,
          status: finalStatus,
        });

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Envío de resumen por WhatsApp fuera de la transacción
      const isConsumidorFinal = conv.bsuid === '2222222' || conv.normalized_phone === '+572222222' || String(conv.display_name || '').toUpperCase() === 'CONSUMIDOR FINAL';
      let whatsappResult = null;
      const trackingToken = typeof issueTrackingToken === 'function' && JWT_SECRET ? issueTrackingToken(createdOrder.id, JWT_SECRET) : null;
      const trackingUrl = trackingToken ? `https://www.distritobg.app/rastrear/${createdOrder.id}?t=${trackingToken}` : `https://www.distritobg.app/rastrear/${createdOrder.id}`;

      if (isConsumidorFinal) {
        whatsappResult = {
          status: 'omitted_consumidor_final',
          message: 'CONSUMIDOR FINAL: ventas presenciales en local, no se envía resumen por WhatsApp.',
        };
      } else if (req.body.sendWhatsAppSummary !== false) {
        const summaryText = formatCrmOrderWhatsAppSummary({
          order: {
            id: createdOrder.id,
            status: finalStatus,
            delivery_type: customerDeliveryType,
            payment_method: paymentCheck.method,
            change_required: changeRequired,
            delivery_fee: deliveryFee,
            total: orderTotal,
            address: orderAddress,
            barrio: orderBarrio,
            tracking_url: trackingUrl,
          },
          items: normalized.cart,
          customer: { name: customerName, deliveryType: customerDeliveryType },
          restaurantName: 'Distric House',
        });

        try {
          const queued = await queueConversationMessage(pool, {
            conversationId: conv.id,
            actorUserId: req.user.id,
            text: summaryText,
            idempotencyKey: `order-summary-${createdOrder.id}`,
          });
          setImmediate(() => { void crmWorker?.processOne?.(); });
          whatsappResult = {
            status: 'queued',
            messageId: queued.messageId,
            message: 'Resumen enviado a la cola de WhatsApp con éxito.',
          };
        } catch (waErr) {
          if (waErr.code === 'WHATSAPP_SESSION_EXPIRED') {
            whatsappResult = {
              status: 'window_closed',
              code: 'WHATSAPP_SESSION_EXPIRED',
              message: 'Ventana de 24 horas cerrada. El pedido fue creado y enviado a cocina, pero no se pudo enviar el texto libre sin plantilla.',
            };
          } else {
            whatsappResult = {
              status: 'failed',
              code: waErr.code || 'WHATSAPP_SEND_ERROR',
              message: waErr.message || 'Error al enviar resumen de WhatsApp.',
            };
          }
        }
      } else {
        whatsappResult = {
          status: 'skipped',
          message: 'Envío de resumen por WhatsApp no solicitado.',
        };
      }

      const responsePayload = {
        status: 'ok',
        order: {
          id: createdOrder.id,
          customer_name: customerName,
          customer_phone: customerPhone,
          address: orderAddress,
          barrio: orderBarrio,
          delivery_type: customerDeliveryType,
          payment_method: paymentCheck.method,
          total: orderTotal,
          subtotal: normalized.total,
          delivery_fee: deliveryFee,
          change_required: changeRequired,
          status: finalStatus,
          cart_json: normalized.cart,
          created_at: createdOrder.created_at,
          tracking_url: trackingUrl,
        },
        whatsapp: whatsappResult,
      };

      if (idempotencyKey) {
        crmOrderIdempotencyCache.set(idempotencyKey, { ...responsePayload, cachedAt: Date.now() });
      }

      return res.status(201).json(responsePayload);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get('/api/pedidos/admin/crm/segments', authenticateToken, requirePermission('CRM','segmentos'), async(req,res)=>{
    try{const {rows}=await pool.query(`SELECT segment.*,creator.name AS creator_name FROM pedidos_app_crm_segments segment LEFT JOIN pedidos_app_users creator ON creator.id=segment.created_by ORDER BY segment.updated_at DESC`);res.json({status:'ok',segments:rows});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/segments/preview', authenticateToken, requirePermission('CRM','segmentos'), campaignLimiter, async(req,res)=>{
    try{const definition=validateSegmentDefinition(req.body.definition);const compiled=compileSegment(definition);const result=await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE contact.marketing_opt_in AND NOT contact.marketing_opt_out AND NOT contact.no_contact)::int AS eligible FROM pedidos_app_crm_contacts contact WHERE contact.deleted_at IS NULL AND ${compiled.sql}`,compiled.params);res.json({status:'ok',...result.rows[0]});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/segments', authenticateToken, requirePermission('CRM','segmentos'), async(req,res)=>{
    const client=await pool.connect();try{const name=cleanText(req.body.name,160);if(!name)throw crmError('SEGMENT_INVALID','El nombre es obligatorio.',400);const type=req.body.segment_type==='STATIC'?'STATIC':'DYNAMIC';const definition=type==='DYNAMIC'?validateSegmentDefinition(req.body.definition):{combinator:'AND',rules:[]};await client.query('BEGIN');const {rows}=await client.query(`INSERT INTO pedidos_app_crm_segments(name,description,segment_type,definition,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING *`,[name,cleanText(req.body.description,500)||null,type,JSON.stringify(definition),req.user.id]);await audit(client,req,'SEGMENT_CREATED','crm_segment',rows[0].id,{type});await client.query('COMMIT');res.status(201).json({status:'ok',segment:rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.put('/api/pedidos/admin/crm/segments/:id', authenticateToken, requirePermission('CRM','segmentos'), async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const current=await readSegment(client,req.params.id);const type=req.body.segment_type==='STATIC'?'STATIC':'DYNAMIC';const definition=type==='DYNAMIC'?validateSegmentDefinition(req.body.definition):current.definition;const {rows}=await client.query(`UPDATE pedidos_app_crm_segments SET name=$2,description=$3,segment_type=$4,definition=$5::jsonb,is_active=$6,updated_by=$7,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,cleanText(req.body.name,160),cleanText(req.body.description,500)||null,type,JSON.stringify(definition),req.body.is_active!==false,req.user.id]);await audit(client,req,'SEGMENT_UPDATED','crm_segment',req.params.id,{type,isActive:req.body.is_active!==false});await client.query('COMMIT');res.json({status:'ok',segment:rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/segments/:id/preview', authenticateToken, requirePermission('CRM','segmentos'), async(req,res)=>{
    try{const segment=await readSegment(pool,req.params.id);const counts=await segmentCount(pool,segment);await pool.query(`UPDATE pedidos_app_crm_segments SET estimated_count=$2,last_evaluated_at=NOW() WHERE id=$1`,[segment.id,counts.total]);res.json({status:'ok',...counts});}catch(error){respondError(res,error);}
  });

  app.delete('/api/pedidos/admin/crm/segments/:id', authenticateToken, requirePermission('CRM','segmentos'), async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const {rowCount}=await client.query(`DELETE FROM pedidos_app_crm_segments WHERE id=$1`,[req.params.id]);if(rowCount===0)throw crmError('SEGMENT_NOT_FOUND','Segmento no encontrado.',404);await audit(client,req,'SEGMENT_DELETED','crm_segment',req.params.id);await client.query('COMMIT');res.json({status:'ok'});}catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23503')respondError(res,crmError('SEGMENT_IN_USE','No se puede borrar porque está en uso por una campaña.',409));else respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/templates', authenticateToken, requirePermission('CRM','campanas'), async(req,res)=>{
    try{const {rows}=await pool.query(`SELECT * FROM pedidos_app_crm_whatsapp_templates ORDER BY updated_at DESC`);res.json({status:'ok',templates:rows});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/templates', authenticateToken, requirePermission('CRM','campanas_crear'), async(req,res)=>{
    try{const name=cleanText(req.body.name,512);if(!/^[a-z0-9_]+$/.test(name))throw crmError('WHATSAPP_TEMPLATE_INVALID','El nombre solo admite minúsculas, números y guion bajo.',400);const {rows}=await pool.query(`INSERT INTO pedidos_app_crm_whatsapp_templates(name,language,category,components,variables,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$6) RETURNING *`,[name,cleanText(req.body.language,20)||'es_CO',['MARKETING','UTILITY','AUTHENTICATION'].includes(req.body.category)?req.body.category:'MARKETING',JSON.stringify(req.body.components||[]),JSON.stringify(req.body.variables||[]),req.user.id]);res.status(201).json({status:'ok',template:rows[0]});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/templates/sync', authenticateToken, requirePermission('CRM','configurar'), sendLimiter, async(req,res)=>{
    const client=await pool.connect();try{const response=await whatsappClient.listTemplates();await client.query('BEGIN');for(const template of response.data||[]){await client.query(`INSERT INTO pedidos_app_crm_whatsapp_templates(provider_template_id,name,language,category,status,components,provider_quality,last_synced_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,NOW(),$8,$8) ON CONFLICT(name,language) DO UPDATE SET provider_template_id=EXCLUDED.provider_template_id,category=EXCLUDED.category,status=EXCLUDED.status,components=EXCLUDED.components,provider_quality=EXCLUDED.provider_quality,last_synced_at=NOW(),updated_at=NOW()`,[template.id,template.name,template.language,template.category,template.status,JSON.stringify(template.components||[]),template.quality_score?.score||null,req.user.id]);}await audit(client,req,'TEMPLATES_SYNCED','whatsapp_templates',null,{count:(response.data||[]).length});await client.query('COMMIT');res.json({status:'ok',count:(response.data||[]).length});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/campaigns', authenticateToken, requirePermission('CRM','campanas'), async(req,res)=>{
    try{const {rows}=await pool.query(`SELECT campaign.*,segment.name AS segment_name,template.name AS template_name,template.language AS template_language FROM pedidos_app_crm_campaigns campaign LEFT JOIN pedidos_app_crm_segments segment ON segment.id=campaign.segment_id LEFT JOIN pedidos_app_crm_whatsapp_templates template ON template.id=campaign.template_id ORDER BY campaign.updated_at DESC`);res.json({status:'ok',campaigns:rows});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/campaigns', authenticateToken, requirePermission('CRM','campanas_crear'), campaignLimiter, async(req,res)=>{
    const client=await pool.connect();try{const name=cleanText(req.body.name,180);if(!name)throw crmError('CAMPAIGN_INVALID','El nombre es obligatorio.',400);const code=slugCode(req.body.code||name)||`CAMP_${Date.now()}`;await client.query('BEGIN');const {rows}=await client.query(`INSERT INTO pedidos_app_crm_campaigns(name,code,objective,segment_id,template_id,message_preview,variables,scheduled_at,attribution_days,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$10) RETURNING *`,[name,code,['SALES','RECOVERY','LOYALTY','INFORMATION','REACTIVATION'].includes(req.body.objective)?req.body.objective:'SALES',req.body.segment_id||null,req.body.template_id||null,cleanText(req.body.message_preview,3000)||null,JSON.stringify(req.body.variables||{}),req.body.scheduled_at||null,req.body.attribution_days||null,req.user.id]);await audit(client,req,'CAMPAIGN_CREATED','crm_campaign',rows[0].id,{code,segmentId:rows[0].segment_id,templateId:rows[0].template_id});await client.query('COMMIT');res.status(201).json({status:'ok',campaign:rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.put('/api/pedidos/admin/crm/campaigns/:id', authenticateToken, requirePermission('CRM','campanas_crear'), async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const current=await client.query(`SELECT status FROM pedidos_app_crm_campaigns WHERE id=$1 FOR UPDATE`,[req.params.id]);if(!current.rows.length)throw crmError('CAMPAIGN_NOT_FOUND','Campaña no encontrada.',404);if(!['DRAFT','PAUSED'].includes(current.rows[0].status))throw crmError('CAMPAIGN_ALREADY_STARTED','Solo se puede editar una campaña en borrador o pausada.',409);const {rows}=await client.query(`UPDATE pedidos_app_crm_campaigns SET name=$2,objective=$3,segment_id=$4,template_id=$5,message_preview=$6,variables=$7::jsonb,scheduled_at=$8,attribution_days=$9,updated_by=$10,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,cleanText(req.body.name,180),req.body.objective,req.body.segment_id||null,req.body.template_id||null,cleanText(req.body.message_preview,3000)||null,JSON.stringify(req.body.variables||{}),req.body.scheduled_at||null,req.body.attribution_days||null,req.user.id]);await audit(client,req,'CAMPAIGN_UPDATED','crm_campaign',req.params.id,{segmentId:rows[0].segment_id,templateId:rows[0].template_id});await client.query('COMMIT');res.json({status:'ok',campaign:rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/campaigns/:id/preview', authenticateToken, requirePermission('CRM','campanas'), campaignLimiter, async(req,res)=>{
    try{const campaign=await pool.query(`SELECT campaign.*,template.status AS template_status FROM pedidos_app_crm_campaigns campaign LEFT JOIN pedidos_app_crm_whatsapp_templates template ON template.id=campaign.template_id WHERE campaign.id=$1`,[req.params.id]);if(!campaign.rows.length)throw crmError('CAMPAIGN_NOT_FOUND','Campaña no encontrada.',404);if(!campaign.rows[0].segment_id)throw crmError('CAMPAIGN_NO_RECIPIENTS','Selecciona un segmento.',409);const segment=await readSegment(pool,campaign.rows[0].segment_id);const counts=await segmentCount(pool,segment);res.json({status:'ok',...counts,excluded:counts.total-counts.eligible,template_status:campaign.rows[0].template_status});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/campaigns/:id/launch', authenticateToken, requirePermission('CRM','campanas_enviar'), campaignLimiter, sendLimiter, async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const campaignResult=await client.query(`SELECT campaign.*,template.name AS template_name,template.language AS template_language,template.status AS template_status FROM pedidos_app_crm_campaigns campaign LEFT JOIN pedidos_app_crm_whatsapp_templates template ON template.id=campaign.template_id WHERE campaign.id=$1 FOR UPDATE OF campaign`,[req.params.id]);if(!campaignResult.rows.length)throw crmError('CAMPAIGN_NOT_FOUND','Campaña no encontrada.',404);const campaign=campaignResult.rows[0];if(!['DRAFT','PAUSED'].includes(campaign.status))throw crmError('CAMPAIGN_ALREADY_STARTED','La campaña ya inició.',409);if(!campaign.segment_id)throw crmError('CAMPAIGN_NO_RECIPIENTS','Selecciona un segmento.',409);if(campaign.template_status!=='APPROVED')throw crmError('WHATSAPP_TEMPLATE_INVALID','La campaña requiere una plantilla aprobada por Meta.',409);const segment=await readSegment(client,campaign.segment_id);const compiled=segmentSelect(segment,2);const frequencyParam=2+compiled.params.length;await client.query(`
        INSERT INTO pedidos_app_crm_campaign_recipients(campaign_id,contact_id,status,exclusion_reason,rendered_variables)
        SELECT $1,contact.id,
          CASE WHEN NOT contact.marketing_opt_in THEN 'EXCLUDED' WHEN contact.marketing_opt_out OR contact.no_contact THEN 'EXCLUDED'
            WHEN EXISTS(SELECT 1 FROM pedidos_app_crm_campaign_recipients previous WHERE previous.contact_id=contact.id AND previous.sent_at>=NOW()-($${frequencyParam}*INTERVAL '1 day')) THEN 'EXCLUDED' ELSE 'PENDING' END,
          CASE WHEN NOT contact.marketing_opt_in THEN 'MARKETING_CONSENT_REQUIRED' WHEN contact.marketing_opt_out OR contact.no_contact THEN 'CONTACT_OPTED_OUT'
            WHEN EXISTS(SELECT 1 FROM pedidos_app_crm_campaign_recipients previous WHERE previous.contact_id=contact.id AND previous.sent_at>=NOW()-($${frequencyParam}*INTERVAL '1 day')) THEN 'FREQUENCY_CAP' ELSE NULL END,
          jsonb_build_object('contact.name',COALESCE(NULLIF(TRIM(contact.display_name),''),'amig@'),'contact.phone',contact.normalized_phone,'contact.barrio',COALESCE(contact.barrio,''),'contact.orders_count',contact.orders_count,'contact.total_spent',contact.total_spent)
        FROM pedidos_app_crm_contacts contact WHERE contact.deleted_at IS NULL AND ${compiled.sql}
        ON CONFLICT(campaign_id,contact_id) DO NOTHING
      `,[campaign.id,...compiled.params,(await client.query('SELECT crm_campaign_frequency_days FROM pedidos_app_settings WHERE id=1')).rows[0]?.crm_campaign_frequency_days||7]);
      const stats=await client.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='PENDING')::int eligible FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=$1`,[campaign.id]);if(!stats.rows[0].eligible)throw crmError('CAMPAIGN_NO_RECIPIENTS','Ningún contacto cumple consentimiento y límites de frecuencia.',409);const scheduled=campaign.scheduled_at&&new Date(campaign.scheduled_at)>new Date();await client.query(`UPDATE pedidos_app_crm_campaigns SET status=$2::varchar,started_at=CASE WHEN $2::text='RUNNING' THEN NOW() ELSE started_at END,recipient_count=$3::int,eligible_count=$4::int,updated_at=NOW() WHERE id=$1::bigint`,[campaign.id,scheduled?'SCHEDULED':'RUNNING',stats.rows[0].total,stats.rows[0].eligible]);await audit(client,req,'CAMPAIGN_LAUNCHED','crm_campaign',campaign.id,{recipients:stats.rows[0].total,eligible:stats.rows[0].eligible,scheduled});await appendCrmEvent(client,'crm.campaign.started','crm_campaign',campaign.id,{campaignId:Number(campaign.id)});await client.query('COMMIT');res.status(202).json({status:'ok',recipients:stats.rows[0].total,eligible:stats.rows[0].eligible,scheduled});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.post('/api/pedidos/admin/crm/campaigns/:id/pause', authenticateToken, requirePermission('CRM','campanas_enviar'), async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const {rows}=await client.query(`UPDATE pedidos_app_crm_campaigns SET status='PAUSED',paused_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN('RUNNING','SCHEDULED') RETURNING *`,[req.params.id]);if(!rows.length)throw crmError('CAMPAIGN_NOT_RUNNING','La campaña no está activa.',409);await audit(client,req,'CAMPAIGN_PAUSED','crm_campaign',req.params.id);await client.query('COMMIT');res.json({status:'ok',campaign:rows[0]});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/automations', authenticateToken, requirePermission('CRM','automatizaciones'), async(req,res)=>{
    try{const {rows}=await pool.query(`SELECT automation.*,COUNT(run.id)::int AS runs_count,COUNT(run.id) FILTER(WHERE run.status='COMPLETED')::int AS completed_runs FROM pedidos_app_crm_automations automation LEFT JOIN pedidos_app_crm_automation_runs run ON run.automation_id=automation.id GROUP BY automation.id ORDER BY automation.updated_at DESC`);res.json({status:'ok',automations:rows});}catch(error){respondError(res,error);}
  });

  app.post('/api/pedidos/admin/crm/automations', authenticateToken, requirePermission('CRM','automatizaciones'), async(req,res)=>{
    try{const name=cleanText(req.body.name,180);if(!name)throw crmError('AUTOMATION_INVALID','El nombre es obligatorio.',400);const trigger=['CONTACT_CREATED','MESSAGE_RECEIVED','ORDER_COMPLETED','INACTIVITY','NO_PURCHASE_AFTER_CONTACT','BIRTHDAY'].includes(req.body.trigger_type)?req.body.trigger_type:null;const action=['ENROLL_CAMPAIGN','ADD_TAG','SET_STATUS','ASSIGN_USER'].includes(req.body.action_type)?req.body.action_type:null;if(!trigger||!action)throw crmError('AUTOMATION_INVALID','Disparador o acción inválidos.',400);if(action==='ADD_TAG'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.tag_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar una etiqueta válida.',400);if(action==='ASSIGN_USER'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.user_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar un usuario válido.',400);if(action==='ENROLL_CAMPAIGN'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.campaign_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar una campaña válida.',400);const {rows}=await pool.query(`INSERT INTO pedidos_app_crm_automations(name,description,trigger_type,trigger_config,conditions,wait_minutes,action_type,action_config,is_active,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$10) RETURNING *`,[name,cleanText(req.body.description,500)||null,trigger,JSON.stringify(req.body.trigger_config||{}),JSON.stringify(req.body.conditions||{combinator:'AND',rules:[]}),Math.max(0,Math.min(525600,Number(req.body.wait_minutes)||0)),action,JSON.stringify(req.body.action_config||{}),Boolean(req.body.is_active),req.user.id]);res.status(201).json({status:'ok',automation:rows[0]});}catch(error){respondError(res,error);}
  });

  app.put('/api/pedidos/admin/crm/automations/:id', authenticateToken, requirePermission('CRM','automatizaciones'), async(req,res)=>{
    try{const action=req.body.action_type;if(action==='ADD_TAG'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.tag_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar una etiqueta válida.',400);if(action==='ASSIGN_USER'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.user_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar un usuario válido.',400);if(action==='ENROLL_CAMPAIGN'&&(!req.body.action_config||!Number.isInteger(Number(req.body.action_config.campaign_id))))throw crmError('AUTOMATION_INVALID','Debes seleccionar una campaña válida.',400);const {rows}=await pool.query(`UPDATE pedidos_app_crm_automations SET name=$2,description=$3,trigger_type=$4,trigger_config=$5::jsonb,conditions=$6::jsonb,wait_minutes=$7,action_type=$8,action_config=$9::jsonb,is_active=$10,updated_by=$11,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,cleanText(req.body.name,180),cleanText(req.body.description,500)||null,req.body.trigger_type,JSON.stringify(req.body.trigger_config||{}),JSON.stringify(req.body.conditions||{combinator:'AND',rules:[]}),Math.max(0,Math.min(525600,Number(req.body.wait_minutes)||0)),req.body.action_type,JSON.stringify(req.body.action_config||{}),Boolean(req.body.is_active),req.user.id]);if(!rows.length)throw crmError('AUTOMATION_NOT_FOUND','Automatización no encontrada.',404);res.json({status:'ok',automation:rows[0]});}catch(error){respondError(res,error);}
  });

  app.delete('/api/pedidos/admin/crm/automations/:id', authenticateToken, requirePermission('CRM','automatizaciones'), async(req,res)=>{
    const client=await pool.connect();try{await client.query('BEGIN');const {rowCount}=await client.query(`DELETE FROM pedidos_app_crm_automations WHERE id=$1`,[req.params.id]);if(rowCount===0)throw crmError('AUTOMATION_NOT_FOUND','Automatización no encontrada.',404);await audit(client,req,'AUTOMATION_DELETED','crm_automation',req.params.id);await client.query('COMMIT');res.json({status:'ok'});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/reports', authenticateToken, requirePermission('CRM','reportes'), async(req,res)=>{
    try{const days=Math.min(366,Math.max(1,Number(req.query.days)||30));const [daily,campaigns,products]=await Promise.all([
      pool.query(`SELECT day::date,COALESCE(messages,0)::int AS messages,COALESCE(conversions,0)::int AS conversions,COALESCE(revenue,0)::bigint AS revenue FROM generate_series((CURRENT_DATE-$1::int),CURRENT_DATE,INTERVAL '1 day') day LEFT JOIN(SELECT date_trunc('day',created_at)::date event_day,COUNT(*)::int messages FROM pedidos_app_crm_messages GROUP BY 1)m ON m.event_day=day::date LEFT JOIN(SELECT date_trunc('day',attributed_at)::date event_day,COUNT(*)::int conversions,SUM(attributed_amount)::bigint revenue FROM pedidos_app_crm_attributions GROUP BY 1)a ON a.event_day=day::date ORDER BY day`,[days-1]),
      pool.query(`SELECT id,name,status,sent_count,delivered_count,read_count,replied_count,converted_count,attributed_revenue FROM pedidos_app_crm_campaigns ORDER BY attributed_revenue DESC,created_at DESC LIMIT 20`),
      pool.query(`SELECT item->>'title' AS product,SUM(COALESCE((item->>'quantity')::int,1))::int AS quantity,COUNT(DISTINCT orders.id)::int AS orders FROM pedidos_app_orders orders CROSS JOIN LATERAL jsonb_array_elements(COALESCE(orders.cart_json,'[]')) item WHERE orders.status IN('Entregado','Completado') GROUP BY 1 ORDER BY quantity DESC LIMIT 15`),
    ]);res.json({status:'ok',daily:daily.rows,campaigns:campaigns.rows,products:products.rows});}catch(error){respondError(res,error);}
  });

  app.get('/api/pedidos/admin/crm/config', authenticateToken, requirePermission('CRM','configurar'), async(req,res)=>{
    try{const [settings,state,queue]=await Promise.all([pool.query(`SELECT crm_inactive_days,crm_frequent_orders,crm_vip_orders,crm_vip_spend,crm_attribution_days,crm_campaign_frequency_days,crm_campaign_start_time,crm_campaign_end_time,timezone FROM pedidos_app_settings WHERE id=1`),pool.query(`SELECT * FROM pedidos_app_crm_provider_state WHERE provider='WHATSAPP'`),pool.query(`SELECT COUNT(*) FILTER(WHERE status IN('PENDING','RETRY','PROCESSING'))::int pending,COUNT(*) FILTER(WHERE status='FAILED')::int failed FROM pedidos_app_crm_message_jobs`)]);res.json({status:'ok',settings:settings.rows[0],whatsapp:{...state.rows[0],configured:whatsappClient.isConfigured(),graph_version_configured:Boolean(whatsappClient.config.graphVersion),phone_number_id_suffix:whatsappClient.config.phoneNumberId?whatsappClient.config.phoneNumberId.slice(-4):null},queue:queue.rows[0]});}catch(error){respondError(res,error);}
  });

  app.put('/api/pedidos/admin/crm/config', authenticateToken, requirePermission('CRM','configurar'), async(req,res)=>{
    const entries=Object.entries(req.body||{}).filter(([key])=>CRM_SETTING_FIELDS.has(key));if(!entries.length)return res.status(400).json({code:'CRM_CONFIG_INVALID',error:'No se recibieron campos de configuración válidos.'});const client=await pool.connect();try{await client.query('BEGIN');for(const [key,value]of entries){await client.query(`UPDATE pedidos_app_settings SET ${key}=$1,updated_at=NOW() WHERE id=1`,[value]);}await audit(client,req,'CRM_CONFIG_UPDATED','settings',1,{fields:entries.map(([key])=>key)});await client.query('COMMIT');res.json({status:'ok'});}catch(error){await client.query('ROLLBACK').catch(()=>{});respondError(res,error);}finally{client.release();}
  });

  app.get('/api/pedidos/admin/crm/export.csv', authenticateToken, requirePermission('CRM','exportar'), exportLimiter, async(req,res)=>{
    try{
      const filters=contactFilters(req.query);
      const {rows}=await pool.query(`
        SELECT display_name,normalized_phone,email,barrio,status,source,orders_count,total_spent,
          average_ticket,last_purchase_at,marketing_opt_in,marketing_opt_out,no_contact
        FROM pedidos_app_crm_contacts contact WHERE ${CONTACT_FILTER_SQL} ORDER BY contact.id
      `,filters.values);
      const columns=['Nombre','Teléfono','Correo','Barrio','Estado','Fuente','Pedidos','Total','Ticket promedio','Última compra','Opt-in','Opt-out','No contactar'];
      const escape=(value)=>`"${String(value??'').replace(/"/g,'""')}"`;
      const lines=[columns,...rows.map(row=>Object.values(row))].map(row=>row.map(escape).join(',')).join('\r\n');
      await audit(pool,req,'CRM_EXPORTED','crm_contacts',null,{count:rows.length,filters:filters.metadata});
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition','attachment; filename="crm-distritobg.csv"');
      res.send(`\uFEFF${lines}`);
    }catch(error){respondError(res,error);}
  });

  return { segmentCount };
};

module.exports.formatCrmOrderWhatsAppSummary = formatCrmOrderWhatsAppSummary;
module.exports.crmOrderIdempotencyCache = crmOrderIdempotencyCache;

