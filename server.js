console.log('🚀 Starting backend server...');

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { createPool, getDatabaseUrl } = require('./src/db');
const { getDashboardSnapshot } = require('./src/dashboard');
const { authorizeTrackingAccess, issueTrackingToken, isFinalOrder } = require('./src/tracking');
const {
  CARRYING_DELIVERY_STATUSES,
  COMMITTED_DELIVERY_STATUSES,
  DEFAULT_MAX_ACTIVE_ORDERS,
  DELIVERY_ROLES,
  normalizeMaxActiveOrders,
} = require('./src/delivery-rules');
const { ORDER_STATUSES, canTransitionOrder } = require('./src/order-rules');
const { createDeliveryOrderService } = require('./src/delivery-order-service');
const { createOutboxDispatcher } = require('./src/outbox');
const { createWhatsAppClient } = require('./src/whatsapp-cloud');
const { createCrmWorker } = require('./src/crm-service');
const { normalizePhoneE164 } = require('./src/crm/phone');

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:soporte@distrito.com';
if (!publicVapidKey || !privateVapidKey) {
  console.error('❌ FATAL: las claves VAPID no están configuradas.');
  process.exit(1);
}
webpush.setVapidDetails(vapidEmail, publicVapidKey, privateVapidKey);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET no está definida en las variables de entorno. El servidor no puede iniciar de forma segura.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const supplied = String(req.headers['x-request-id'] || '').trim();
  req.requestId = /^[a-z0-9._-]{1,100}$/i.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const startedAt = Date.now();
  res.on('finish', () => {
    const requestPath = String(req.originalUrl || req.url).split('?')[0];
    if (!/^\/api\/pedidos\/(delivery|admin\/delivery|auth\/me|track\/|webhooks\/whatsapp|admin\/crm\/)/.test(requestPath)) return;
    const component = requestPath.includes('/crm/') || requestPath.includes('/webhooks/whatsapp')
      ? 'crm-http'
      : 'delivery-http';
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      component, request_id: req.requestId,
      method: req.method, path: requestPath,
      status: res.statusCode, duration_ms: Date.now() - startedAt,
      user_id: req.user?.id || null, driver_id: req.deliveryUser?.id || null,
      order_id: /^\d+$/.test(String(req.params?.id || '')) ? Number(req.params.id) : null,
      crm_entity_id: component === 'crm-http' && /^\d+$/.test(String(req.params?.id || '')) ? Number(req.params.id) : null,
      device_id: String(req.headers['x-device-id'] || '').slice(0, 100) || null,
    }));
  });
  next();
});

// Restringir CORS a dominios conocidos
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = [
  ...configuredOrigins,
  'https://distritobg.app',          // Web principal
  'https://admin.distritobg.app',    // Panel admin
  'https://delivery.distritobg.app', // PWA domiciliarios
  'https://www.distritobg.app',      // Por si usan www
  'https://distrito-web.vercel.app', // Vercel (fallback)
  'https://distrito-admin.vercel.app',
  /\.vercel\.app$/,                  // Previews de Vercel
  /^http:\/\/localhost/,             // Desarrollo local
];
app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (Postman, Render health checks)
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) return callback(null, true);
    return callback(new Error(`CORS: Origen no permitido: ${origin}`));
  },
  credentials: true,
}));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({
  limit: '25mb',
  verify: (req, res, buffer) => {
    if (String(req.originalUrl || req.url).startsWith('/api/pedidos/webhooks/whatsapp')) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiadas solicitudes, intente de nuevo en 15 minutos.' }
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos de pedido. Intente nuevamente en un minuto.' }
});

const inventoryLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Límite de consultas de código de barras alcanzado. Intente en un minuto.' }
});

const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas consultas de seguimiento. Intente nuevamente en un minuto.' }
});

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const MAX_DEVICE_SESSIONS = 3;
const DEFAULT_IDLE_MINUTES = 60;
const MIN_PASSWORD_LENGTH = 10;

let getHorariosStatus = async () => ({ isOpen: false, statusText: 'No disponible' });
let outboxReady = false;
let crmWorkerReady = false;
app.use(express.urlencoded({ limit: '25mb', extended: true }));

const dbUrl = getDatabaseUrl();
const pool = createPool();
const whatsappClient = createWhatsAppClient();
const crmWorker = createCrmWorker({ pool, whatsappClient });
pool.connect()
  .then(client => {
    console.log('✅ Conectado a Neon correctamente');
    client.release();
  })
  .catch(err => {
    console.error('❌ Error conectando a Neon:', err);
  });

app.get('/api/pedidos/health', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT current_database() AS database,
             (SELECT COUNT(*)::int FROM pedidos_app_schema_migrations) AS migrations,
             (SELECT COUNT(*)::int FROM pedidos_app_domain_events WHERE published_at IS NULL) AS outbox_pending,
             (SELECT MIN(occurred_at) FROM pedidos_app_domain_events WHERE published_at IS NULL) AS outbox_oldest,
             (SELECT COUNT(*)::int FROM pedidos_app_driver_location_points WHERE received_at >= NOW()-INTERVAL '5 minutes') AS gps_points_5m,
             (SELECT COUNT(*)::int FROM pedidos_app_delivery_profiles WHERE shift_active) AS active_shifts,
             (SELECT COUNT(*)::int FROM pedidos_app_crm_message_jobs WHERE status IN ('PENDING','RETRY','PROCESSING')) AS crm_queue_depth,
             (SELECT MAX(received_at) FROM pedidos_app_crm_webhook_events WHERE provider='WHATSAPP') AS whatsapp_last_webhook
    `);
    res.json({
      status: 'ok', database: rows[0].database, migrations: rows[0].migrations,
      components: {
        postgres: 'ok', outbox: outboxReady ? 'ok' : 'starting',
        sse: { clients: deliveryRealtime.stats?.().clients || 0 },
         push: publicVapidKey && privateVapidKey ? 'configured' : 'unavailable',
         gps: { pointsLast5Minutes: rows[0].gps_points_5m, activeShifts: rows[0].active_shifts },
         crm: { queue: crmWorkerReady ? 'ok' : 'starting', queueDepth: rows[0].crm_queue_depth },
         whatsapp: { configured: whatsappClient.isConfigured(), lastWebhookAt: rows[0].whatsapp_last_webhook },
      },
      outbox: { pending: rows[0].outbox_pending, oldest: rows[0].outbox_oldest },
    });
  } catch (error) {
    res.status(503).json({ status: 'error', error: 'Base de datos no disponible' });
  }
});

const FINAL_ORDER_STATUSES = new Set(['Entregado', 'Completado']);
let deliveryRealtime = { publish: () => {}, sendPush: async () => {} };

function normalizeDeliveryLocation(customer = {}) {
  const rawLatitude = customer.latitude ?? customer.deliveryLatitude;
  const rawLongitude = customer.longitude ?? customer.deliveryLongitude;
  const hasLatitude = rawLatitude !== '' && rawLatitude !== null && rawLatitude !== undefined;
  const hasLongitude = rawLongitude !== '' && rawLongitude !== null && rawLongitude !== undefined;

  if (hasLatitude !== hasLongitude) {
    const error = new Error('La latitud y longitud de entrega deben enviarse juntas.');
    error.statusCode = 400;
    throw error;
  }
  if (!hasLatitude) return { latitude: null, longitude: null };

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    const error = new Error('Las coordenadas de entrega no son válidas.');
    error.statusCode = 400;
    throw error;
  }
  return { latitude, longitude };
}

async function getInventoryAvailability(client, inventoryId, branchId = 1) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(available_quantity), 0) AS quantity FROM pedidos_app_inventory_lots WHERE inventory_id = $1 AND branch_id = $2 AND status = \'Disponible\'',
    [inventoryId, branchId]
  );
  return Number(rows[0].quantity);
}

function skuPrefix(value) {
  const normalized = String(value || 'ITEM').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const letters = normalized.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
  return letters || 'ITEM';
}

async function generateIngredientSku(client, category) {
  const prefix = skuPrefix(category);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [prefix]);
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS total FROM pedidos_app_inventory WHERE sku LIKE $1',
    [`${prefix}-%`]
  );
  return `${prefix}-${String(Number(rows[0].total) + 1).padStart(4, '0')}`;
}

async function createInventoryMovement(client, data) {
  const { rows } = await client.query(
    `INSERT INTO pedidos_app_inventory_movements
      (inventory_id, lot_id, branch_id, movement_type, quantity, unit_cost, balance_after, reference_type, reference_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.inventoryId, data.lotId || null, data.branchId || 1, data.type, data.quantity, data.unitCost || 0,
    data.balanceAfter ?? null, data.referenceType || null, data.referenceId ? String(data.referenceId) : null,
    data.notes || null, data.createdBy || 'Administrador']
  );
  return rows[0];
}

// Wrapper de reconexión automática para manejar el "Cold Start" de Neon
const originalQuery = pool.query.bind(pool);
pool.query = async function (text, params) {
  const MAX_RETRIES = 3;
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await originalQuery(text, params);
    } catch (err) {
      lastError = err;
      // Si el error es de sintaxis (código que empieza con 42), fallar de inmediato
      if (err.code && err.code.startsWith('42')) throw err;

      console.warn(`[Neon DB] Intento ${i + 1}/${MAX_RETRIES} falló. Reintentando en ${1000 * (i + 1)}ms... Error: ${err.message}`);
      // Esperar 1 segundo en el primer intento, 2 en el segundo...
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  console.error('[Neon DB] Fallo crítico después de múltiples reintentos.');
  throw lastError;
};

// Datos de prueba iniciales basados en el frontend
const seedProducts = [
  { title: 'Hamburguesa Clásica', description: 'Carne 100% de res, queso cheddar, lechuga, tomate y nuestra salsa secreta.', price: 15000, category: 'hamburguesas', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=500' },
  { title: 'Doble Bacon Burger', description: 'Doble carne, doble queso, tocino crujiente, cebolla caramelizada y salsa BBQ.', price: 22000, category: 'hamburguesas', image: 'https://images.unsplash.com/photo-1594212691516-b2a9e94bd548?auto=format&fit=crop&q=80&w=500' },
  { title: 'Pizza Pepperoni', description: 'Salsa de tomate artesanal, mozzarella fundida y doble pepperoni.', price: 28000, category: 'pizzas', image: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&q=80&w=500' },
  { title: 'Coca-Cola Zero 500ml', description: 'Bebida refrescante sin azúcar.', price: 5000, category: 'bebidas', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&q=80&w=500' },
  { title: 'Limonada de Coco', description: 'Refrescante limonada natural con crema de coco.', price: 8000, category: 'bebidas', image: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&q=80&w=500' },
  { title: 'Cheesecake de Frutos Rojos', description: 'Suave tarta de queso con base de galleta y coulis de frutos rojos.', price: 12000, category: 'postres', image: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&q=80&w=500' }
];

function absoluteApiUrl(req, path) {
  return `${req.protocol}://${req.get('host')}/api/pedidos${path}`;
}

function productForResponse(req, product) {
  if (!product) return product;
  const { has_image: hasImage, ...data } = product;
  if (hasImage || data.image) {
    const version = data.updated_at ? new Date(data.updated_at).getTime() : '';
    data.image = `${absoluteApiUrl(req, `/media/products/${data.id}`)}${version ? `?v=${version}` : ''}`;
  }
  return data;
}

function announcementForResponse(req, announcement) {
  if (!announcement) return announcement;
  const { has_image: hasImage, ...data } = announcement;
  const now = Date.now();
  const startsAt = data.starts_at ? new Date(data.starts_at).getTime() : null;
  const endsAt = data.ends_at ? new Date(data.ends_at).getTime() : null;
  data.is_visible = Boolean(data.is_active)
    && (!startsAt || startsAt <= now)
    && (!endsAt || endsAt >= now);
  if (hasImage || data.image_url) {
    const version = data.updated_at ? new Date(data.updated_at).getTime() : '';
    data.image_url = `${absoluteApiUrl(req, `/media/announcements/${data.id}`)}${version ? `?v=${version}` : ''}`;
  }
  return data;
}

function settingsForResponse(req, settings) {
  if (!settings) return settings;
  const data = { ...settings };
  const version = data.updated_at ? new Date(data.updated_at).getTime() : '';
  if (data.logo) {
    data.logo = `${absoluteApiUrl(req, '/media/settings-logo')}${version ? `?v=${version}` : ''}`;
  }
  ['web', 'admin', 'delivery'].forEach((surface) => {
    const key = `${surface}_logo`;
    if (data[key]) data[key] = `${absoluteApiUrl(req, `/media/settings-logo/${surface}`)}${version ? `?v=${version}` : ''}`;
  });
  return data;
}

function isManagedMediaUrl(value, resource, id) {
  return typeof value === 'string' && value.includes(`/api/pedidos/media/${resource}/${id}`);
}

function sendStoredMedia(res, value) {
  if (!value) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  if (/^https?:\/\//i.test(value)) return res.redirect(302, value);

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match) return res.status(415).json({ error: 'Formato de imagen no compatible' });

  const buffer = Buffer.from(match[2], 'base64');
  res.set('Content-Type', match[1]);
  return res.send(buffer);
}

async function normalizeOrderCart(client, rawCart, { activeOnly = true } = {}) {
  if (!Array.isArray(rawCart) || rawCart.length === 0 || rawCart.length > 100) {
    const error = new Error('El pedido debe contener entre 1 y 100 productos.');
    error.statusCode = 400;
    throw error;
  }

  const ids = [...new Set(rawCart.map((item) => String(item.id || item.product_id || '')).filter(Boolean))];
  const { rows } = await client.query(
    `SELECT id, title, price, category, stock, track_stock
     FROM pedidos_app_products
     WHERE id::text = ANY($1::text[]) AND ($2::boolean = FALSE OR status = 'Activo')`,
    [ids, activeOnly]
  );
  const products = new Map(rows.map((product) => [String(product.id), product]));

  const cart = rawCart.map((item) => {
    const id = String(item.id || item.product_id || '');
    const product = products.get(id);
    const quantity = Number(item.quantity || item.qty || 1);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      const error = new Error('El carrito contiene un producto o cantidad inválida.');
      error.statusCode = 400;
      throw error;
    }
    return {
      id: product.id,
      title: product.title,
      price: Number(product.price),
      category: product.category || 'General',
      quantity,
      notes: String(item.notes || item.observations || item.observaciones || '').trim().slice(0, 500),
    };
  });

  return {
    cart,
    inventory: rows
      .filter((product) => product.track_stock)
      .map((product) => ({
        id: product.id,
        title: product.title,
        stock: Number(product.stock) || 0,
        quantity: cart.find((item) => String(item.id) === String(product.id))?.quantity || 0,
      })),
    total: cart.reduce((sum, item) => sum + item.price * item.quantity, 0),
  };
}

async function reserveProductStock(client, normalized, orderId, createdBy = 'Sistema') {
  for (const item of normalized.inventory || []) {
    const { rows } = await client.query(`
      UPDATE pedidos_app_products
      SET stock = COALESCE(stock, 0) - $1, updated_at = NOW()
      WHERE id = $2 AND track_stock = TRUE AND COALESCE(stock, 0) >= $1
      RETURNING stock
    `, [item.quantity, item.id]);
    if (!rows.length) {
      const error = new Error(`No hay existencias suficientes de ${item.title}.`);
      error.statusCode = 409;
      error.code = 'INSUFFICIENT_STOCK';
      throw error;
    }
    await client.query(`
      INSERT INTO pedidos_app_product_stock_movements
        (product_id, order_id, movement_type, quantity, balance_after, reason, created_by)
      VALUES ($1,$2,'Pedido',-$3,$4,$5,$6)
    `, [item.id, orderId, item.quantity, rows[0].stock, `Reserva del pedido #${orderId}`, createdBy]);
  }
}

async function releaseProductStock(client, order, createdBy = 'Sistema') {
  const { rows: movements } = await client.query(`
    SELECT product_id, -SUM(quantity)::int AS quantity
    FROM pedidos_app_product_stock_movements
    WHERE order_id = $1
    GROUP BY product_id
    HAVING SUM(quantity) < 0
  `, [order.id]);
  for (const movement of movements) {
    const { rows } = await client.query(`
      UPDATE pedidos_app_products SET stock = COALESCE(stock, 0) + $1, updated_at = NOW()
      WHERE id = $2 RETURNING stock
    `, [movement.quantity, movement.product_id]);
    if (!rows.length) continue;
    await client.query(`
      INSERT INTO pedidos_app_product_stock_movements
        (product_id, order_id, movement_type, quantity, balance_after, reason, created_by)
      VALUES ($1,$2,'Cancelación',$3,$4,$5,$6)
    `, [movement.product_id, order.id, movement.quantity, rows[0].stock, `Devolución del pedido #${order.id}`, createdBy]);
  }
}

const deliveryOrderService = createDeliveryOrderService({ pool, releaseProductStock });

app.get('/api/pedidos/media/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT image FROM pedidos_app_products WHERE id::text = $1', [req.params.id]);
    return sendStoredMedia(res, rows[0]?.image);
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar la imagen' });
  }
});

app.get('/api/pedidos/media/announcements/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT image_url FROM pedidos_app_announcements WHERE id = $1', [req.params.id]);
    return sendStoredMedia(res, rows[0]?.image_url);
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar la imagen' });
  }
});

app.get('/api/pedidos/media/settings-logo', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT logo FROM pedidos_app_settings WHERE id = 1');
    return sendStoredMedia(res, rows[0]?.logo);
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar el logo' });
  }
});

app.get('/api/pedidos/media/settings-logo/:surface', async (req, res) => {
  const fields = { web: 'web_logo', admin: 'admin_logo', delivery: 'delivery_logo' };
  const field = fields[req.params.surface];
  if (!field) return res.status(404).end();
  try {
    const { rows } = await pool.query(`SELECT COALESCE(${field}, logo) AS logo FROM pedidos_app_settings WHERE id = 1`);
    return sendStoredMedia(res, rows[0]?.logo);
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar el logo' });
  }
});

app.get('/api/pedidos/init', async (req, res) => {
  try {
    // Si no hay dbUrl configurada, devolver datos de prueba
    if (!dbUrl) {
      console.log('No database connection URL found. Returning mock data.');
      return res.json({
        status: 'ok',
        products: seedProducts.map((p, i) => ({ id: i + 1, ...p })),
        settings: { whatsapp_number: '', nequi_number: '', bancolombia_number: '' }
      });
    }

    const { rows: products } = await pool.query(`
      SELECT id, title, description, price, category, status, is_active, is_featured,
             stock, track_stock, low_stock_threshold, inventory_unit, barcode,
             rating_sum, rating_count, created_at, updated_at, image IS NOT NULL AS has_image
      FROM pedidos_app_products
      WHERE status = 'Activo'
      ORDER BY id DESC
    `);
    const { rows: categories } = await pool.query("SELECT * FROM pedidos_app_categories WHERE status = 'Activa' ORDER BY id ASC");

    // Asumimos que settings es solo una fila
    let settingsRow = { whatsapp_number: '', nequi_number: '', bancolombia_number: '' };
    try {
      const { rows: settings } = await pool.query('SELECT * FROM pedidos_app_settings LIMIT 1');
      if (settings.length > 0) settingsRow = settings[0];
    } catch (err) {
      console.log('Settings table might not exist yet.');
    }

    // Anuncio
    let announcementRow = null;
    try {
      const { rows: announcements } = await pool.query(`
        SELECT id, title, body, cta_label, cta_url, starts_at, ends_at,
               display_frequency, campaign_type, audience, priority, coupon_code,
               views_count, clicks_count, is_active, updated_at, image_url IS NOT NULL AS has_image
        FROM pedidos_app_announcements
        WHERE is_active = TRUE
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
          AND audience = 'all'
        ORDER BY priority DESC, updated_at DESC, id DESC LIMIT 1
      `);
      if (announcements.length > 0) announcementRow = announcements[0];
    } catch (err) {
      console.log('Announcement table might not exist yet.');
    }

    res.json({
      status: 'ok',
      products: products.map((product) => productForResponse(req, product)),
      categories,
      settings: settingsForResponse(req, settingsRow),
      announcement: announcementForResponse(req, announcementRow)
    });
  } catch (error) {
    console.error('Error fetching init data:', error);
    // Fallback a los datos de prueba si la tabla no existe (42P01)
    if (error.code === '42P01') {
      return res.json({
        status: 'ok',
        products: seedProducts.map((p, i) => ({ id: i + 1, ...p })),
        settings: { whatsapp_number: '', nequi_number: '', bancolombia_number: '' },
        message: 'Devolviendo datos locales. Ejecuta npm run migrate en distrito-api para preparar PostgreSQL.'
      });
    }
    res.status(500).json({ status: 'error', message: 'Fallo al conectar con la base de datos', details: error.message });
  }
});





// Helper for checking if accounting date is closed
const isDateClosed = async (isoDate) => {
  if (!isoDate) return false;
  try {
    const d = isoDate.split('T')[0];
    const res = await pool.query("SELECT id FROM pedidos_app_closures WHERE start_date <= $1 AND end_date >= $2 AND status = 'Cerrado'", [d, d]);
    return res.rows.length > 0;
  } catch (e) { return false; }
};

function parseColombiaTimestamp(value) {
  if (!value) return null;
  let normalized = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T12:00:00-05:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(normalized)) normalized += '-05:00';
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error('La fecha y hora del pedido no son válidas.');
    error.statusCode = 400;
    throw error;
  }
  return parsed.toISOString();
}

app.post('/api/pedidos/checkout', checkoutLimiter, async (req, res) => {
  let client;
  try {
    const status = await getHorariosStatus();
    if (!status.isOpen) {
      return res.status(423).json({
        status: 'error', code: 'STORE_CLOSED',
        error: `El restaurante no recibe pedidos en este momento. ${status.statusText}`,
        schedule: status,
      });
    }

    const { customer, cart } = req.body;
    if (!customer || typeof customer !== 'object' || !customer.name || (!customer.phone && !customer.crm_contact_id)) {
      return res.status(400).json({ error: 'Nombre, teléfono o contacto del cliente son obligatorios.' });
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const normalized = await normalizeOrderCart(client, cart);
    const isDelivery = String(customer.deliveryType || '').toLowerCase() === 'domicilio';
    const settingsResult = await client.query('SELECT COALESCE(delivery_cost, 0)::integer AS delivery_cost FROM pedidos_app_settings WHERE id = 1');
    const deliveryFee = isDelivery ? Math.max(0, Number(settingsResult.rows[0]?.delivery_cost || 0)) : 0;
    const orderTotal = normalized.total + deliveryFee;
    const cashAmount = Number(customer.cashAmount);
    if (String(customer.paymentMethod || '').toLowerCase() === 'efectivo'
        && Number.isFinite(cashAmount) && cashAmount > 0 && cashAmount < orderTotal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `El efectivo indicado no cubre el total de $${orderTotal.toLocaleString('es-CO')}.` });
    }

    let customDateStr = req.body.created_at || (customer && customer.created_at);
    const customDate = parseColombiaTimestamp(customDateStr);

    if (customDate && await isDateClosed(customDate)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'El período contable para esta fecha ya está cerrado.' });
    }

    // Format phone to always start with 57
    let formattedPhone = customer.phone ? customer.phone.replace(/\D/g, '') : null;
    if (formattedPhone && formattedPhone.length === 10) {
      formattedPhone = '57' + formattedPhone;
    } else if (formattedPhone && formattedPhone.length > 10 && !formattedPhone.startsWith('57')) {
      formattedPhone = '57' + formattedPhone;
    }

    let finalStatus = req.body.status || 'Nuevo';
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const token = req.headers.authorization.split(' ')[1];
      if (token !== process.env.ADMIN_TOKEN) {
        try {
          const jwt = require('jsonwebtoken');
          const user = jwt.verify(token, process.env.JWT_SECRET);
          if (user && user.role && !DELIVERY_ROLES.has(user.role) && ORDER_STATUSES.has(req.body.status)) {
            finalStatus = req.body.status;
          }
        } catch (e) {}
      }
    }

    const deliveryLocation = normalizeDeliveryLocation(customer);
    const { rows } = await client.query(
      `INSERT INTO pedidos_app_orders 
       (customer_name, customer_phone, address, barrio, delivery_type, payment_method, total, cart_json, source, notes, voucher_reference, created_at,
        delivery_fee, delivery_reference, change_required, delivery_latitude, delivery_longitude,
        delivery_place_id, delivery_location_adjusted, delivery_apartment, delivery_tower, delivery_floor, status, crm_contact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, NOW()),
         $15, $13, $14, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       RETURNING id`,
      [
        customer.name,
        formattedPhone,
        customer.address || '',
        customer.barrio || '',
        customer.deliveryType,
        customer.paymentMethod,
        orderTotal,
        JSON.stringify(normalized.cart),
        req.body.source || customer.source || 'Web',
        customer.notes || customer.comment || '',
        customer.voucher_reference || '',
        customDate,
        customer.reference || customer.deliveryReference || '',
        customer.paymentMethod === 'efectivo' && Number(customer.cashAmount) >= orderTotal
          ? Math.round(Number(customer.cashAmount) - orderTotal)
          : null,
        deliveryFee,
        isDelivery ? deliveryLocation.latitude : null,
        isDelivery ? deliveryLocation.longitude : null,
        isDelivery ? String(customer.placeId || customer.googlePlaceId || '').trim().slice(0, 255) || null : null,
        isDelivery && customer.locationAdjusted === true,
        isDelivery ? String(customer.apartment || '').trim().slice(0, 50) || null : null,
        isDelivery ? String(customer.tower || '').trim().slice(0, 50) || null : null,
        isDelivery ? String(customer.floor || '').trim().slice(0, 30) || null : null,
        finalStatus,
        customer.crm_contact_id || null
      ]
    );

    await reserveProductStock(client, normalized, rows[0].id, req.body.source || 'Web');
    await deliveryOrderService.appendDomainEvent(client, 'order_created', 'order', rows[0].id, {
      orderId: rows[0].id,
      orderStatus: finalStatus,
      source: req.body.source || customer.source || 'Web',
      deliveryType: customer.deliveryType,
      total: orderTotal,
    });
    await client.query('COMMIT');

    res.status(201).json({
      status: 'ok',
      order_id: rows[0].id,
      subtotal: normalized.total,
      delivery_fee: deliveryFee,
      total: orderTotal,
      change_required: customer.paymentMethod === 'efectivo' && Number(customer.cashAmount) >= orderTotal
        ? Math.round(Number(customer.cashAmount) - orderTotal)
        : null,
      tracking_token: issueTrackingToken(rows[0].id, JWT_SECRET),
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error guardando orden:', error);
    res.status(error.statusCode || 500).json({ status: 'error', code: error.code, error: error.message, message: error.message });
  } finally {
    if (client) client.release();
  }
});
// ── Rastreo público por ID + últimos 4 dígitos del teléfono ─────────────────
app.get('/api/pedidos/rastrear/:id', trackingLimiter, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Base de datos no configurada' });
    const id = parseInt(req.params.id, 10);
    const code = (req.query.c || '').replace(/\D/g, '').slice(-4);
    if (!id || id <= 0) return res.status(400).json({ error: 'ID de pedido inválido' });
    if (!code || code.length < 4) return res.status(400).json({ error: 'Código de verificación requerido' });

    const { rows } = await pool.query(`
      SELECT order_data.id, order_data.customer_name, order_data.customer_phone,
             order_data.delivery_type, order_data.total, order_data.status, order_data.delivery_status,
             order_data.address, order_data.barrio,
             order_data.delivery_latitude, order_data.delivery_longitude,
             order_data.cart_json, order_data.created_at, order_data.updated_at,
             order_data.completed_at, order_data.delivered_at, order_data.delivery_completed_at,
             order_data.picked_up_at, order_data.on_the_way_at,
             order_data.delivery_duration_seconds, order_data.delivery_user_id,
             order_data.delivery_provider_type, order_data.external_delivery_company_id,
             order_data.external_eta_minutes, company.name AS external_company_name,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.current_latitude ELSE NULL END AS driver_latitude,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.current_longitude ELSE NULL END AS driver_longitude,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.last_location_at ELSE NULL END AS driver_location_at,
             CASE WHEN order_data.delivery_status = 'En camino' THEN TRIM(CONCAT(driver.name, ' ', driver.last_name)) ELSE NULL END AS driver_name,
             CASE WHEN order_data.delivery_status = 'En camino' THEN profile.vehicle_type ELSE NULL END AS vehicle_type,
             CASE WHEN order_data.delivery_status = 'En camino' THEN profile.plate ELSE NULL END AS plate,
             settings.restaurant_name, COALESCE(settings.kitchen_address, settings.address) AS store_address,
             settings.store_latitude, settings.store_longitude
      FROM pedidos_app_orders order_data
      LEFT JOIN pedidos_app_users driver ON driver.id = order_data.delivery_user_id
      LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = order_data.delivery_user_id
      LEFT JOIN pedidos_app_delivery_companies company ON company.id = order_data.external_delivery_company_id
      LEFT JOIN pedidos_app_settings settings ON settings.id = 1
      WHERE order_data.id = $1
    `, [id]);

    if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const order = rows[0];

    // Verificar los últimos 4 dígitos del teléfono
    const phoneDigits = (order.customer_phone || '').replace(/\D/g, '').slice(-4);
    if (phoneDigits !== code) {
      return res.status(403).json({ error: 'Código de verificación incorrecto' });
    }

    // Si el pedido ya finalizó, indicarlo pero no bloquear (el cliente puede ver que fue entregado)
    const finalStatuses = new Set(['Entregado', 'Completado', 'Cancelado']);
    const isFinal = finalStatuses.has(order.status) || finalStatuses.has(order.delivery_status);

    let driverTrail = [];
    if (!isFinal && order.delivery_status === 'En camino' && order.delivery_user_id != null) {
      const trailResult = await pool.query(`
        SELECT latitude, longitude, captured_at AS recorded_at
        FROM pedidos_app_driver_location_points
        WHERE driver_id = $1
          AND captured_at >= COALESCE($2::timestamptz,captured_at)
          AND captured_at <= COALESCE($3::timestamptz,NOW())
        ORDER BY captured_at DESC LIMIT 120
      `, [order.delivery_user_id, order.picked_up_at || order.on_the_way_at, order.delivery_completed_at]);
      driverTrail = trailResult.rows.reverse().map((p) => ({
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
        recorded_at: p.recorded_at,
      }));
    }

    res.json({
      status: 'ok',
      is_final: isFinal,
      order: {
        id: order.id,
        customer_name: order.customer_name,
        delivery_type: order.delivery_type,
        total: Number(order.total),
        order_status: order.status,
        delivery_status: order.delivery_status,
        delivery_provider_type: order.delivery_provider_type || (order.delivery_user_id ? 'own' : null),
        tracking_mode: String(order.delivery_provider_type || '').startsWith('external_') ? 'status' : 'gps',
        external_delivery: order.external_delivery_company_id == null ? null : {
          company_name: order.external_company_name,
          eta_minutes: order.external_eta_minutes == null ? null : Number(order.external_eta_minutes),
        },
        items: (order.cart_json || []).map((item) => ({ title: item.title, quantity: item.quantity || item.qty || 1 })),
        created_at: order.created_at,
        updated_at: order.updated_at,
        completed_at: order.completed_at,
        delivered_at: order.delivered_at,
        delivery_duration_seconds: order.delivery_duration_seconds == null ? null : Number(order.delivery_duration_seconds),
        store: {
          name: order.restaurant_name || 'Distrito BG',
          address: order.store_address || 'Valledupar, Colombia',
          latitude: Number(order.store_latitude ?? 10.4631),
          longitude: Number(order.store_longitude ?? -73.2532),
        },
        destination: order.delivery_latitude == null || order.delivery_longitude == null ? null : {
          address: [order.address, order.barrio].filter(Boolean).join(', '),
          latitude: Number(order.delivery_latitude),
          longitude: Number(order.delivery_longitude),
        },
        driver: order.delivery_user_id == null || String(order.delivery_provider_type || '').startsWith('external_') ? null : {
          name: order.driver_name,
          vehicle_type: order.vehicle_type,
          plate: order.plate,
          latitude: order.driver_latitude == null ? null : Number(order.driver_latitude),
          longitude: order.driver_longitude == null ? null : Number(order.driver_longitude),
          updated_at: order.driver_location_at,
        },
        driver_trail: driverTrail,
        has_live_gps: !String(order.delivery_provider_type || '').startsWith('external_')
          && order.driver_latitude != null && order.driver_longitude != null,
      },
    });
  } catch (error) {
    console.error('Error en rastrear:', error);
    res.status(500).json({ error: 'Error interno al consultar el pedido' });
  }
});

app.get('/api/pedidos/track/:id', trackingLimiter, async (req, res) => {

  try {
    const id = Number(req.params.id);
    await authorizeTrackingAccess(pool, {
      orderId: id,
      phone: req.query.phone,
      token: req.query.token,
      secret: JWT_SECRET,
    });
    const { rows } = await pool.query(`
      SELECT order_data.id, order_data.customer_name, order_data.customer_phone,
             order_data.delivery_type, order_data.total, order_data.status, order_data.delivery_status,
             order_data.address, order_data.barrio,
             order_data.delivery_latitude, order_data.delivery_longitude,
             order_data.cart_json, order_data.created_at, order_data.updated_at,
             order_data.completed_at, order_data.delivered_at, order_data.delivery_completed_at,
             order_data.picked_up_at, order_data.on_the_way_at,
             order_data.delivery_duration_seconds, order_data.delivery_user_id,
             order_data.delivery_provider_type, order_data.external_delivery_company_id,
             order_data.external_eta_minutes, company.name AS external_company_name,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.current_latitude ELSE NULL END AS driver_latitude,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.current_longitude ELSE NULL END AS driver_longitude,
             CASE WHEN order_data.delivery_status = 'En camino'
                       AND profile.last_location_at >= COALESCE(order_data.picked_up_at,order_data.on_the_way_at)
                  THEN profile.last_location_at ELSE NULL END AS driver_location_at,
             CASE WHEN order_data.delivery_status = 'En camino' THEN TRIM(CONCAT(driver.name, ' ', driver.last_name)) ELSE NULL END AS driver_name,
             CASE WHEN order_data.delivery_status = 'En camino' THEN profile.vehicle_type ELSE NULL END AS vehicle_type,
             CASE WHEN order_data.delivery_status = 'En camino' THEN profile.plate ELSE NULL END AS plate,
             settings.restaurant_name, COALESCE(settings.kitchen_address, settings.address) AS store_address,
             settings.store_latitude, settings.store_longitude
      FROM pedidos_app_orders order_data
      LEFT JOIN pedidos_app_users driver ON driver.id = order_data.delivery_user_id
      LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = order_data.delivery_user_id
      LEFT JOIN pedidos_app_delivery_companies company ON company.id = order_data.external_delivery_company_id
      LEFT JOIN pedidos_app_settings settings ON settings.id = 1
      WHERE order_data.id = $1
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'No encontramos el pedido' });
    const order = rows[0];
    let driverTrail = [];
    if (order.delivery_status === 'En camino' && order.delivery_user_id != null) {
      const trailResult = await pool.query(`
        SELECT latitude, longitude, captured_at AS recorded_at
        FROM pedidos_app_driver_location_points
        WHERE driver_id = $1
          AND captured_at >= COALESCE($2::timestamptz,captured_at)
          AND captured_at <= COALESCE($3::timestamptz,NOW())
        ORDER BY captured_at DESC
        LIMIT 120
      `, [order.delivery_user_id, order.picked_up_at || order.on_the_way_at, order.delivery_completed_at]);
      driverTrail = trailResult.rows.reverse().map((point) => ({
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
        recorded_at: point.recorded_at,
      }));
    }
    res.json({
      status: 'ok',
      order: {
        id: order.id,
        customer_name: order.customer_name,
        delivery_type: order.delivery_type,
        total: Number(order.total),
        order_status: order.status,
        delivery_status: order.delivery_status,
        delivery_provider_type: order.delivery_provider_type || (order.delivery_user_id ? 'own' : null),
        tracking_mode: String(order.delivery_provider_type || '').startsWith('external_') ? 'status' : 'gps',
        external_delivery: order.external_delivery_company_id == null ? null : {
          company_name: order.external_company_name,
          eta_minutes: order.external_eta_minutes == null ? null : Number(order.external_eta_minutes),
        },
        items: (order.cart_json || []).map((item) => ({ title: item.title, quantity: item.quantity || item.qty || 1 })),
        created_at: order.created_at,
        updated_at: order.updated_at,
        completed_at: order.completed_at,
        delivered_at: order.delivered_at,
        delivery_completed_at: order.delivery_completed_at,
        delivery_duration_seconds: order.delivery_duration_seconds == null ? null : Number(order.delivery_duration_seconds),
        store: {
          name: order.restaurant_name || 'Distrito BG',
          address: order.store_address || 'Valledupar, Colombia',
          latitude: Number(order.store_latitude ?? 10.4631),
          longitude: Number(order.store_longitude ?? -73.2532),
        },
        destination: order.delivery_latitude == null || order.delivery_longitude == null ? null : {
          address: [order.address, order.barrio].filter(Boolean).join(', '),
          latitude: Number(order.delivery_latitude),
          longitude: Number(order.delivery_longitude),
        },
        driver: order.delivery_user_id == null || String(order.delivery_provider_type || '').startsWith('external_') ? null : {
          id: Number(order.delivery_user_id),
          name: order.driver_name,
          vehicle_type: order.vehicle_type,
          plate: order.plate,
          latitude: order.driver_latitude == null ? null : Number(order.driver_latitude),
          longitude: order.driver_longitude == null ? null : Number(order.driver_longitude),
          updated_at: order.driver_location_at,
          trail: driverTrail,
        },
        has_live_gps: !String(order.delivery_provider_type || '').startsWith('external_')
          && order.driver_latitude != null && order.driver_longitude != null,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      code: error.code,
      error: error.statusCode ? error.message : 'No fue posible consultar el pedido',
    });
  }
});

// Funciones Globales y Middleware
const logActivity = async (userId, module, action, details, ip, os, browser, requestData) => {
  if (!dbUrl) return;
  try {
    await pool.query(
      `INSERT INTO pedidos_app_audit_logs (user_id, module, action, details, ip, os, browser, request_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, module, action, details, ip, os, browser, JSON.stringify(requestData)]
    );
  } catch (e) {
    console.error('Error logging activity:', e);
  }
};

const requirePermission = (moduleName, actionName) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Acceso denegado' });
  if (req.user.role === 'Super Administrador') return next();

  try {
    const { rows } = await pool.query(`
      SELECT rp.* FROM pedidos_app_role_permissions rp
      JOIN pedidos_app_permissions p ON rp.permission_id = p.id
      WHERE rp.role_id = $1 AND p.module = $2 AND p.action = $3
    `, [req.user.role_id, moduleName, actionName]);

    if (rows.length === 0) {
      return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
    }
    next();
  } catch (error) {
    console.error('Error verificando permisos:', error);
    res.status(500).json({ error: 'Error interno verificando permisos' });
  }
};

// AUTH MIDDLEWARE
const expireInactiveSessions = async (client, userId = null) => {
  const params = userId ? [userId] : [];
  const userFilter = userId ? 'AND s.user_id = $1' : '';
  await client.query(`
    UPDATE pedidos_app_sessions s
    SET status = CASE WHEN s.expires_at <= NOW() THEN 'Expirada' ELSE 'Expirada por inactividad' END,
        revoked_at = NOW()
    FROM pedidos_app_users u
    LEFT JOIN pedidos_app_roles r ON r.id = u.role_id
    WHERE s.user_id = u.id
      AND s.status = 'Activa'
      AND (s.expires_at <= NOW()
        OR (
          COALESCE(r.name, u.role, '') NOT IN ('Domiciliario', 'Repartidor')
          AND s.last_active < NOW() - make_interval(mins => COALESCE(u.session_idle_minutes, $${userId ? 2 : 1}))
        ))
      ${userFilter}
  `, userId ? [userId, DEFAULT_IDLE_MINUTES] : [DEFAULT_IDLE_MINUTES]);
};

const getAuthUser = async (client, userId) => {
  const { rows } = await client.query(`
    SELECT u.id, u.username, u.name, u.last_name, u.email, u.phone, u.photo_url,
           u.role_id, u.role, u.must_change_password, u.max_active_sessions,
           u.session_idle_minutes, r.name AS role_name
    FROM pedidos_app_users u
    LEFT JOIN pedidos_app_roles r ON r.id = u.role_id
    WHERE u.id = $1 AND u.status = 'Activo'
  `, [userId]);
  if (!rows.length) return null;
  const user = rows[0];
  const { rows: permissionRows } = user.role_id ? await client.query(`
    SELECT p.module, p.action
    FROM pedidos_app_role_permissions rp
    JOIN pedidos_app_permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = $1
    ORDER BY p.module, p.action
  `, [user.role_id]) : { rows: [] };
  return {
    user: {
      id: user.id, username: user.username, name: user.name, last_name: user.last_name,
      email: user.email, phone: user.phone, photo_url: user.photo_url,
      role: user.role_name || user.role, role_id: user.role_id,
      max_active_sessions: Math.min(Number(user.max_active_sessions) || MAX_DEVICE_SESSIONS, MAX_DEVICE_SESSIONS),
      session_idle_minutes: Number(user.session_idle_minutes) || DEFAULT_IDLE_MINUTES,
    },
    permissions: permissionRows.map((permission) => `${permission.module}:${permission.action}`),
    must_change_password: Boolean(user.must_change_password),
  };
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acceso denegado' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });

    // Validar en DB si la sesión está activa y actualizar último acceso
    if (user.jti && dbUrl) {
      try {
        await expireInactiveSessions(pool, user.id);
        const { rows } = await pool.query(
          "SELECT id, status, last_active, expires_at FROM pedidos_app_sessions WHERE token_jti = $1 AND user_id = $2",
          [user.jti, user.id]
        );
        if (rows.length === 0 || rows[0].status !== 'Activa') {
          return res.status(401).json({ code: 'SESSION_EXPIRED', error: 'La sesión finalizó o caducó por inactividad' });
        }
        await pool.query(
          "UPDATE pedidos_app_sessions SET last_active = NOW() WHERE token_jti = $1 AND last_active < NOW() - INTERVAL '60 seconds'",
          [user.jti]
        );
        if (user.id) {
          await pool.query("UPDATE pedidos_app_users SET last_access = NOW() WHERE id = $1", [user.id]);
        }
      } catch (e) {
        console.error("Error validando sesión:", e);
        return res.status(503).json({ error: 'No fue posible validar la sesión' });
      }
    }

    req.user = user;
    next();
  });
};

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.hostinger.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/api/pedidos/admin/forgot-password', authLimiter, async (req, res) => {
  const { email, app: requestedApp } = req.body;
  if (!email) return res.status(400).json({ error: 'El correo es obligatorio' });

  try {
    const { rows } = await pool.query('SELECT id, username FROM pedidos_app_users WHERE email = $1 AND status = $2', [email, 'Activo']);
    if (rows.length === 0) {
      // Para evitar enumeración de correos, devolvemos OK aunque no exista
      return res.json({ status: 'ok', message: 'Si el correo existe, recibirás un enlace de recuperación.' });
    }

    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hora

    await pool.query('UPDATE pedidos_app_users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3', [resetToken, expiry, user.id]);

    const resetLink = requestedApp === 'delivery'
      ? `https://delivery.distritobg.app/reset-password?token=${resetToken}`
      : `https://admin.distritobg.app/admin/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: '"Soporte Distrito BG" <' + (process.env.EMAIL_USER || 'soporte@distritobg.com') + '>',
      to: email,
      subject: 'Recuperación de Contraseña - Distrito BG',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #D4A017;">Distrito BG</h2>
          <p>Hola <b>${user.username}</b>,</p>
          <p>Hemos recibido una solicitud para restablecer tu contraseña. Si fuiste tú, haz clic en el siguiente enlace (válido por 1 hora):</p>
          <a href="${resetLink}" style="display: inline-block; padding: 10px 20px; background-color: #D4A017; color: #000; text-decoration: none; border-radius: 5px; font-weight: bold;">Restablecer mi contraseña</a>
          <br><br>
          <p>Si el botón no funciona, copia y pega el siguiente enlace en tu navegador:</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <p>Si no solicitaste este cambio, puedes ignorar este correo de forma segura.</p>
        </div>
      `
    };

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail(mailOptions);
    } else {
      console.warn("⚠️ EMAIL_USER o EMAIL_PASS no configurados en .env. El enlace generado es:", resetLink);
    }

    const ua = req.headers['user-agent'] || '-';
    await pool.query(`INSERT INTO pedidos_app_audit_logs (action, user_id, username_attempted, ip, os, browser, details) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Solicitud de Recuperación', user.id, user.username, req.ip, ua.substring(0, 50), '-', `Correo enviado a ${email}`]
    );

    res.json({ status: 'ok', message: 'Si el correo existe, recibirás un enlace de recuperación.' });
  } catch (error) {
    console.error('Error en forgot-password:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/pedidos/admin/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Faltan datos' });

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` });
  }

  try {
    const { rows } = await pool.query('SELECT id, username, reset_token_expiry FROM pedidos_app_users WHERE reset_token = $1', [token]);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Token inválido o expirado' });
    }

    const user = rows[0];
    if (new Date() > new Date(user.reset_token_expiry)) {
      return res.status(400).json({ error: 'El enlace ha expirado. Solicita uno nuevo.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE pedidos_app_users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2', [hashedPassword, user.id]);

    const ua = req.headers['user-agent'] || '-';
    await pool.query(`INSERT INTO pedidos_app_audit_logs (action, user_id, username_attempted, ip, os, browser, details) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Contraseña Restablecida', user.id, user.username, req.ip, ua.substring(0, 50), '-', `Contraseña recuperada exitosamente`]
    );

    res.json({ status: 'ok', message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('Error en reset-password:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
app.post('/api/pedidos/admin/login', authLimiter, async (req, res) => {
  try {
    const { username, password, deviceId, deviceName } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Desconocida';
    const userAgent = req.headers['user-agent'] || 'Desconocido';
    const os = userAgent.includes('Windows') ? 'Windows' : userAgent.includes('Mac') ? 'Mac' : userAgent.includes('Android') ? 'Android' : userAgent.includes('iPhone') ? 'iPhone' : 'Otro';
    const browser = userAgent.includes('Chrome') ? 'Chrome' : userAgent.includes('Firefox') ? 'Firefox' : userAgent.includes('Safari') ? 'Safari' : 'Otro';

    const { rows } = await pool.query(`
      SELECT u.*, r.name as role_name
      FROM pedidos_app_users u
      LEFT JOIN pedidos_app_roles r ON u.role_id = r.id
      WHERE u.username = $1 OR u.email = $1 OR u.document = $1
    `, [username]);

    if (rows.length === 0) {
      await pool.query("INSERT INTO pedidos_app_audit_logs (username_attempted, action, ip, browser, os) VALUES ($1, 'Intento Fallido (Usuario no existe)', $2, $3, $4)", [username, ip, browser, os]);
      return res.status(401).json({ error: 'Usuario o contraseña incorrecta' });
    }

    const user = rows[0];

    if (user.status !== 'Activo') {
      return res.status(403).json({ error: 'La cuenta está desactivada' });
    }

    if (user.blocked_until && new Date(user.blocked_until) > new Date()) {
      return res.status(403).json({ error: 'Cuenta bloqueada temporalmente por demasiados intentos. Intente más tarde.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      const newFails = (user.failed_attempts || 0) + 1;
      let blockedUntil = null;
      if (newFails >= 5) {
        blockedUntil = new Date(Date.now() + 15 * 60000); // 15 mins
      }
      await pool.query("UPDATE pedidos_app_users SET failed_attempts = $1, blocked_until = $2 WHERE id = $3", [newFails, blockedUntil, user.id]);
      await pool.query("INSERT INTO pedidos_app_audit_logs (user_id, username_attempted, action, ip, browser, os) VALUES ($1, $2, 'Intento Fallido (Clave incorrecta)', $3, $4, $5)", [user.id, username, ip, browser, os]);

      if (newFails >= 5) {
         return res.status(403).json({ error: 'Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.' });
      }
      return res.status(401).json({ error: 'Usuario o contraseña incorrecta' });
    }

    await expireInactiveSessions(pool, user.id);
    const safeDeviceId = String(deviceId || crypto.randomUUID()).slice(0, 100);
    const safeDeviceName = String(deviceName || `${browser} en ${os}`).slice(0, 160);
    await pool.query(
      "UPDATE pedidos_app_sessions SET status = 'Reemplazada en el mismo dispositivo', revoked_at = NOW() WHERE user_id = $1 AND device_id = $2 AND status = 'Activa'",
      [user.id, safeDeviceId]
    );
    const { rows: sessions } = await pool.query(`
      SELECT id, device_name, browser, os, last_active
      FROM pedidos_app_sessions
      WHERE user_id = $1 AND status = 'Activa'
      ORDER BY last_active DESC
    `, [user.id]);
    const sessionLimit = Math.min(Number(user.max_active_sessions) || MAX_DEVICE_SESSIONS, MAX_DEVICE_SESSIONS);
    if (sessions.length >= sessionLimit) {
      return res.status(409).json({
        code: 'SESSION_LIMIT_REACHED',
        error: `Alcanzaste el límite de ${sessionLimit} dispositivos activos. Cierra una sesión desde tu perfil.`,
        sessions,
      });
    }

    // Reset fails
    await pool.query("UPDATE pedidos_app_users SET failed_attempts = 0, blocked_until = NULL, last_access = NOW() WHERE id = $1", [user.id]);

    const jti = crypto.randomUUID();
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role_name || user.role, role_id: user.role_id, jti }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
    const refreshToken = jwt.sign({ id: user.id, jti }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      "INSERT INTO pedidos_app_sessions (user_id, token_jti, ip, browser, os, device_id, device_name, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Activa', $8)",
      [user.id, jti, ip, browser, os, safeDeviceId, safeDeviceName, expiresAt]
    );

    await pool.query("INSERT INTO pedidos_app_audit_logs (user_id, username_attempted, action, ip, browser, os) VALUES ($1, $2, 'Ingreso Exitoso', $3, $4, $5)", [user.id, username, ip, browser, os]);

    const authData = await getAuthUser(pool, user.id);
    res.json({ status: 'ok', token, refreshToken, ...authData });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/pedidos/admin/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(refreshToken, JWT_SECRET, async (err, payload) => {
    if (err) return res.status(403).json({ error: 'Invalid refresh token' });

    await expireInactiveSessions(pool, payload.id);
    const { rows: sessions } = await pool.query(
      "SELECT status FROM pedidos_app_sessions WHERE token_jti = $1 AND user_id = $2",
      [payload.jti, payload.id]
    );
    if (!sessions.length || sessions[0].status !== 'Activa') {
      return res.status(401).json({ code: 'SESSION_EXPIRED', error: 'La sesión finalizó o caducó por inactividad' });
    }
    const authData = await getAuthUser(pool, payload.id);
    if (!authData) return res.status(401).json({ error: 'Usuario no disponible' });
    const user = authData.user;
    const token = jwt.sign({
      id: user.id,
      username: user.username,
      role: user.role_name || user.role,
      role_id: user.role_id,
      jti: payload.jti
    }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
    await pool.query("UPDATE pedidos_app_sessions SET last_active = NOW() WHERE token_jti = $1", [payload.jti]);
    res.json({ status: 'ok', token, ...authData });
  });
});

app.post('/api/pedidos/admin/logout', authenticateToken, async (req, res) => {
  if (req.user && req.user.jti && dbUrl) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE pedidos_app_sessions
        SET status='Cerrada por usuario', revoked_at=NOW()
        WHERE token_jti=$1 AND user_id=$2
        RETURNING device_id
      `, [req.user.jti, req.user.id]);
      if (rows[0]?.device_id) {
        await client.query(`
          UPDATE pedidos_app_delivery_profiles
          SET tracking_device_id=NULL, tracking_lease_at=NULL, gps_status='unavailable',
              availability_status=CASE WHEN shift_active THEN 'Desconectado' ELSE availability_status END,
              updated_at=NOW()
          WHERE user_id=$1 AND tracking_device_id=$2
        `, [req.user.id, rows[0].device_id]);
      }
      await client.query("INSERT INTO pedidos_app_audit_logs (user_id, action) VALUES ($1, 'Cierre de Sesión')", [req.user.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  res.json({ status: 'ok' });
});

app.get('/api/pedidos/admin/verify', authenticateToken, async (req, res) => {
  const authData = await getAuthUser(pool, req.user.id);
  if (!authData) return res.status(401).json({ error: 'Usuario no disponible' });
  res.json({ status: 'ok', ...authData });
});

// Sesiones del propio usuario. Estas rutas son compartidas por Admin y Delivery
// y no dependen del prefijo administrativo.
app.get('/api/pedidos/auth/me/sessions', authenticateToken, async (req, res) => {
  try {
    await expireInactiveSessions(pool, req.user.id);
    const { rows } = await pool.query(`
      SELECT id, device_id, device_name, browser, os, ip, location, status,
             created_at, last_active, expires_at, token_jti=$2 AS is_current
      FROM pedidos_app_sessions
      WHERE user_id=$1
      ORDER BY (status='Activa') DESC, last_active DESC
      LIMIT 20
    `, [req.user.id, req.user.jti]);
    res.json({ status: 'ok', data: rows });
  } catch (error) {
    console.error('Error consultando sesiones propias:', error);
    res.status(500).json({ error: 'No fue posible consultar tus dispositivos' });
  }
});

app.delete('/api/pedidos/auth/me/sessions/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query(`
      SELECT id, device_id, token_jti, status
      FROM pedidos_app_sessions
      WHERE id=$1 AND user_id=$2
      FOR UPDATE
    `, [req.params.id, req.user.id]);
    if (!session.rowCount || session.rows[0].status !== 'Activa') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sesión activa no encontrada' });
    }
    const wasCurrent = session.rows[0].token_jti === req.user.jti;
    await client.query(`
      UPDATE pedidos_app_sessions
      SET status='Cerrada desde perfil', revoked_at=NOW()
      WHERE id=$1 AND user_id=$2
    `, [req.params.id, req.user.id]);
    const releasedTracking = await client.query(`
      UPDATE pedidos_app_delivery_profiles
      SET tracking_device_id=NULL, tracking_lease_at=NULL, gps_status='unavailable',
          availability_status=CASE WHEN shift_active THEN 'Desconectado' ELSE availability_status END,
          updated_at=NOW()
      WHERE user_id=$1 AND tracking_device_id=$2
      RETURNING user_id
    `, [req.user.id, session.rows[0].device_id]);
    await client.query(`
      INSERT INTO pedidos_app_audit_logs
        (user_id,username_attempted,module,action,details,request_data)
      VALUES ($1,$2,'Perfil','Revocar dispositivo',$3,$4::jsonb)
    `, [req.user.id, req.user.username || null, `Sesión #${req.params.id} revocada por su propietario`, JSON.stringify({
      sessionId: Number(req.params.id), deviceId: session.rows[0].device_id,
      wasCurrent, releasedTracking: releasedTracking.rowCount > 0,
    })]);
    const eventId = crypto.randomUUID();
    await client.query(`
      INSERT INTO pedidos_app_domain_events
        (event_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES ($1,'session',$2,'session_revoked',$3::jsonb)
    `, [eventId, String(req.params.id), JSON.stringify({
      eventId, userId: req.user.id, sessionId: Number(req.params.id),
      deviceId: session.rows[0].device_id, releasedTracking: releasedTracking.rowCount > 0,
    })]);
    await client.query('COMMIT');
    res.json({ status: 'ok', was_current: wasCurrent, released_tracking: releasedTracking.rowCount > 0 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error revocando sesión propia:', error);
    res.status(500).json({ error: 'No fue posible cerrar la sesión seleccionada' });
  } finally {
    client.release();
  }
});

const requireAdministrativeUser = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(role_data.name, app_user.role) AS role
      FROM pedidos_app_users app_user
      LEFT JOIN pedidos_app_roles role_data ON role_data.id = app_user.role_id
      WHERE app_user.id = $1 AND app_user.status = 'Activo'
    `, [req.user.id]);
    if (!rows.length) {
      return res.status(403).json({ error: 'Esta cuenta no tiene acceso al panel administrativo' });
    }
    const isDeliveryThemeRead = DELIVERY_ROLES.has(rows[0].role)
      && req.method === 'GET'
      && /\/admin\/settings(?:\?|$)/.test(req.originalUrl);
    if (DELIVERY_ROLES.has(rows[0].role) && !isDeliveryThemeRead) {
      return res.status(403).json({ error: 'Esta cuenta no tiene acceso al panel administrativo' });
    }
    req.user.role = rows[0].role;
    next();
  } catch (error) {
    console.error('Error validando acceso administrativo:', error);
    res.status(500).json({ error: 'No fue posible validar el acceso administrativo' });
  }
};

// Login, recuperación, refresh, logout y verify están arriba porque la
// autenticación es compartida. El resto del prefijo /admin pertenece al ERP.
app.use('/api/pedidos/admin', authenticateToken, requireAdministrativeUser);

app.get('/api/pedidos/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    const dashboard = await getDashboardSnapshot(pool, getHorariosStatus);
    res.json({ status: 'ok', dashboard });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ status: 'error', error: 'No fue posible cargar el resumen operativo.' });
  }
});

// Obtener todas las categorías para el panel admin
app.get('/api/pedidos/admin/categories', authenticateToken, async (req, res) => {
  try {
    if (!dbUrl) {
      return res.json({ status: 'ok', categories: [] });
    }

    // Obtener categorías y contar productos relacionados
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.description, c.image, c.status, COUNT(p.id) as products
      FROM pedidos_app_categories c
      LEFT JOIN pedidos_app_products p ON c.name = p.category
      GROUP BY c.id
      ORDER BY c.id ASC
    `);

    res.json({ status: 'ok', categories: rows });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Crear categoría
app.post('/api/pedidos/admin/categories', authenticateToken, async (req, res) => {
  try {
    const { name, description, image, status } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO pedidos_app_categories (name, description, image, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, image, status || 'Activa']
    );
    res.json({ status: 'ok', category: rows[0] });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Actualizar categoría
app.put('/api/pedidos/admin/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, image, status } = req.body;
    const { rows } = await pool.query(
      'UPDATE pedidos_app_categories SET name = $1, description = $2, image = $3, status = $4 WHERE id = $5 RETURNING *',
      [name, description, image, status, id]
    );
    res.json({ status: 'ok', category: rows[0] });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Eliminar categoría
app.delete('/api/pedidos/admin/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_categories WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Obtener todas las ordenes para admin
// ── Clientes: Autocompletar por nombre o teléfono ────────────────────────────
app.get('/api/pedidos/admin/clientes/buscar', authenticateToken, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ status: 'ok', clientes: [] });

    // Se busca en CRM contacts para incluir clientes BSUID (username) y clientes normales (phone/name)
    const { rows } = await pool.query(`
      SELECT 
        c.display_name AS name,
        COALESCE(c.normalized_phone, '') AS phone,
        c.address,
        c.barrio,
        'domicilio' AS delivery_type,
        'efectivo' AS payment_method,
        COALESCE(c.source, 'MANUAL') AS source,
        '' AS notes,
        c.id AS crm_contact_id,
        c.username,
        c.bsuid
      FROM pedidos_app_crm_contacts c
      WHERE c.display_name ILIKE $1
         OR c.normalized_phone LIKE $2
         OR COALESCE(c.username, '') ILIKE $1
         OR COALESCE(c.bsuid, '') ILIKE $1
         OR c.id::text = $3
      ORDER BY c.last_purchase_at DESC NULLS LAST, c.updated_at DESC
      LIMIT 15
    `, [`%${q}%`, `%${q.replace(/\D/g, '')}%`, q]);
    
    res.json({ status: 'ok', clientes: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

const CUSTOMER_SEGMENT_SQL = `CASE contact.status
  WHEN 'VIP' THEN 'VIP'
  WHEN 'INACTIVO' THEN 'En riesgo'
  WHEN 'NO_CONTACTAR' THEN 'En riesgo'
  WHEN 'NUEVO_CONTACTO' THEN 'Sin pedidos'
  WHEN 'PROSPECTO' THEN 'Sin pedidos'
  WHEN 'CLIENTE_NUEVO' THEN 'Nuevo'
  ELSE CASE WHEN contact.id IS NULL THEN 'Sin pedidos' ELSE 'Frecuente' END END`;

app.get('/api/pedidos/admin/customers', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim();
    const status = ['Activo', 'Inactivo', 'Bloqueado'].includes(req.query.status) ? req.query.status : '';
    const allowedSegments = ['Sin pedidos', 'En riesgo', 'VIP', 'Frecuente', 'Nuevo'];
    const segment = allowedSegments.includes(req.query.segment) ? req.query.segment : '';
    const params = [`%${search}%`, status, segment, limit, (page - 1) * limit];
    const base = `
      WITH enriched AS (
        SELECT c.id, c.name, c.phone, c.avatar_url, c.email, c.address, c.barrio,
               c.status, c.tags, c.notes, c.birthday, c.marketing_opt_in,
               c.preferred_delivery_type, c.preferred_payment_method, c.last_contact_at,
               c.created_at, c.updated_at, contact.id AS crm_contact_id,contact.status AS crm_status,
               contact.source AS crm_source,COALESCE(contact.orders_count,0) AS orders_count,
               COALESCE(contact.orders_count,0) AS completed_orders,
               COALESCE(contact.cancelled_orders,0) AS cancelled_orders,
               COALESCE(contact.total_spent,0) AS total_spent,
               COALESCE(contact.average_ticket,0) AS average_ticket,
               contact.first_purchase_at AS first_order_at, contact.last_purchase_at AS last_order_at,
               ${CUSTOMER_SEGMENT_SQL} AS segment
        FROM pedidos_app_customers c
        LEFT JOIN pedidos_app_crm_contact_customers link ON link.customer_id=c.id
        LEFT JOIN pedidos_app_crm_contacts contact ON contact.id=link.contact_id
      )`;
    const where = `WHERE ($1 = '%%' OR name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 OR barrio ILIKE $1)
                     AND ($2 = '' OR status = $2) AND ($3 = '' OR segment = $3)`;
    const [listResult, summaryResult] = await Promise.all([
      pool.query(`${base} SELECT *, COUNT(*) OVER()::int AS filtered_count FROM enriched ${where}
        ORDER BY last_order_at DESC NULLS LAST, updated_at DESC LIMIT $4 OFFSET $5`, params),
      pool.query(`${base} SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'Activo')::int AS active,
        COUNT(*) FILTER (WHERE segment = 'VIP')::int AS vip,
        COUNT(*) FILTER (WHERE segment = 'En riesgo')::int AS at_risk,
        COALESCE(SUM(total_spent),0)::bigint AS lifetime_value FROM enriched`),
    ]);
    const total = listResult.rows[0]?.filtered_count || 0;
    res.json({ status: 'ok', customers: listResult.rows.map(({ filtered_count, ...row }) => row),
      summary: summaryResult.rows[0], pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

app.get('/api/pedidos/admin/customers/:id', authenticateToken, async (req, res) => {
  try {
    const customer = await pool.query(`
      SELECT customer.*,contact.id AS crm_contact_id,contact.status AS crm_status,contact.source AS crm_source,
        COALESCE(contact.orders_count,0) AS orders_count,COALESCE(contact.cancelled_orders,0) AS cancelled_orders,
        COALESCE(contact.total_spent,0) AS total_spent,COALESCE(contact.average_ticket,0) AS average_ticket,
        contact.first_purchase_at AS first_order_at,contact.last_purchase_at AS last_order_at
      FROM pedidos_app_customers customer
      LEFT JOIN pedidos_app_crm_contact_customers link ON link.customer_id=customer.id
      LEFT JOIN pedidos_app_crm_contacts contact ON contact.id=link.contact_id
      WHERE customer.id=$1
    `, [req.params.id]);
    if (!customer.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    const orders = await pool.query(`
      SELECT id, created_at, delivery_type, payment_method, total, status, source, address, barrio, cart_json
      FROM pedidos_app_orders
      WHERE crm_contact_id=$1 OR ($1::bigint IS NULL AND customer_phone_e164=$2)
      ORDER BY created_at DESC LIMIT 100`, [customer.rows[0].crm_contact_id, customer.rows[0].phone_e164]);
    res.json({ status: 'ok', customer: customer.rows[0], orders: orders.rows });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

async function syncCustomerMarketingConsent(client, customerId, granted, actorUserId, { recordOptOut = false } = {}) {
  if (!granted && !recordOptOut) return;
  const contact = await client.query(`
    UPDATE pedidos_app_crm_contacts crm_contact
    SET marketing_opt_in=$2,
        marketing_opt_out=CASE WHEN $2 THEN FALSE ELSE TRUE END,
        no_contact=CASE WHEN $2 THEN FALSE ELSE TRUE END,
        opt_out_reason=CASE WHEN $2 THEN NULL ELSE 'Preferencia actualizada desde Clientes' END,
        status=CASE WHEN $2 THEN crm_contact.status ELSE 'NO_CONTACTAR' END,
        updated_at=NOW()
    FROM pedidos_app_crm_contact_customers link
    WHERE link.customer_id=$1 AND crm_contact.id=link.contact_id
    RETURNING crm_contact.id
  `, [customerId, granted]);
  if (!contact.rows.length) return;
  await client.query(`
    INSERT INTO pedidos_app_crm_consents
      (contact_id,channel,consent_type,granted,source,evidence,actor_user_id)
    VALUES ($1,'WHATSAPP','MARKETING',$2,'CUSTOMER_PROFILE',$3::jsonb,$4)
  `, [contact.rows[0].id, granted, JSON.stringify({ customerId: Number(customerId) }), actorUserId || null]);
  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.rows[0].id]);
}

app.post('/api/pedidos/admin/customers', authenticateToken, async (req, res) => {
  const normalizedPhone = normalizePhoneE164(req.body.phone);
  const phone = normalizedPhone?.slice(1) || '';
  const name = String(req.body.name || '').trim();
  if (!name || !normalizedPhone) return res.status(400).json({ error: 'Nombre y teléfono colombiano válido son obligatorios' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO pedidos_app_customers
      (name, phone, email, address, barrio, status, tags, notes, birthday, marketing_opt_in)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, phone, String(req.body.email || '').trim() || null, String(req.body.address || '').trim() || null,
      String(req.body.barrio || '').trim() || null, ['Activo','Inactivo','Bloqueado'].includes(req.body.status) ? req.body.status : 'Activo',
      Array.isArray(req.body.tags) ? req.body.tags.slice(0, 20).map(String) : [], String(req.body.notes || '').slice(0, 3000),
      req.body.birthday || null, Boolean(req.body.marketing_opt_in)]);
    await syncCustomerMarketingConsent(client, rows[0].id, Boolean(req.body.marketing_opt_in), req.user.id);
    await client.query('COMMIT');
    res.status(201).json({ status: 'ok', customer: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Ya existe un cliente con este teléfono' : error.message });
  } finally { client.release(); }
});

app.put('/api/pedidos/admin/customers/:id', authenticateToken, async (req, res) => {
  const normalizedPhone = normalizePhoneE164(req.body.phone);
  const phone = normalizedPhone?.slice(1) || '';
  const name = String(req.body.name || '').trim();
  if (!name || !normalizedPhone) return res.status(400).json({ error: 'Nombre y teléfono colombiano válido son obligatorios' });
  const status = ['Activo','Inactivo','Bloqueado'].includes(req.body.status) ? req.body.status : 'Activo';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query('SELECT marketing_opt_in FROM pedidos_app_customers WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!previous.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const { rows } = await client.query(`UPDATE pedidos_app_customers SET
      name=$1, phone=$2, email=$3, address=$4, barrio=$5, status=$6, tags=$7,
      notes=$8, birthday=$9, marketing_opt_in=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *`,
    [name, phone, String(req.body.email || '').trim() || null, String(req.body.address || '').trim() || null,
      String(req.body.barrio || '').trim() || null, status,
      Array.isArray(req.body.tags) ? req.body.tags.slice(0, 20).map(String) : [], String(req.body.notes || '').slice(0, 3000),
      req.body.birthday || null, Boolean(req.body.marketing_opt_in), req.params.id]);
    const consentChanged = Boolean(previous.rows[0].marketing_opt_in) !== Boolean(req.body.marketing_opt_in);
    if (consentChanged) {
      await syncCustomerMarketingConsent(client, rows[0].id, Boolean(req.body.marketing_opt_in), req.user.id, { recordOptOut: true });
    }
    await client.query('COMMIT');
    res.json({ status: 'ok', customer: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Ya existe un cliente con este teléfono' : error.message });
  } finally { client.release(); }
});

app.post('/api/pedidos/admin/customers/:id/contact', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE pedidos_app_customers SET last_contact_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING last_contact_at', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ status: 'ok', last_contact_at: rows[0].last_contact_at });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pedidos/admin/orders', authenticateToken, async (req, res) => {
  try {
    if (!dbUrl) return res.json({ status: 'ok', orders: [] });
    const requestedLimit = Number.parseInt(req.query.limit, 10) || 300;
    const limit = Math.min(Math.max(requestedLimit, 1), 500);
    const { rows } = await pool.query(`
      SELECT id, customer_name, customer_phone, address, barrio, delivery_type,
             payment_method, total, status, source, notes, cart_json,
             voucher_reference, created_at, updated_at, delivered_at,
             delivery_user_id, delivery_status, delivery_fee, delivery_reference,
             delivery_latitude, delivery_longitude, delivery_place_id,
             delivery_location_adjusted, delivery_apartment, delivery_tower, delivery_floor,
             change_required, delivery_accepted_at, picked_up_at, on_the_way_at,
             delivery_completed_at, delivery_distance_km, delivery_duration_seconds,
             tracking_sent_at, delivery_provider_type, external_delivery_company_id,
             external_driver_name, external_driver_phone, external_vehicle_id,
             external_delivery_cost, external_delivery_notes, external_eta_minutes,
             external_assigned_at, external_handed_off_at, external_delivery_confirmed_at,
             external_delivery_confirmed_by_name, external_delivery_confirmation_notes,
             (SELECT name FROM pedidos_app_delivery_companies company
              WHERE company.id = external_delivery_company_id) AS external_company_name,
             (delivery_fee - external_delivery_cost) AS logistics_margin
      FROM pedidos_app_orders
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ status: 'ok', orders: rows });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/orders/:id/tracking-token', authenticateToken, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: 'Pedido inválido' });
    const { rows } = await pool.query(`
      SELECT id, status, delivery_status
      FROM pedidos_app_orders
      WHERE id = $1
    `, [orderId]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (isFinalOrder(rows[0])) return res.status(409).json({ error: 'El seguimiento de este pedido ya finalizó' });
    res.json({ status: 'ok', tracking_token: issueTrackingToken(orderId, JWT_SECRET) });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible generar el enlace de seguimiento' });
  }
});

app.post('/api/pedidos/admin/orders/:id/tracking-sent', authenticateToken, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: 'Pedido inválido' });
    await pool.query('UPDATE pedidos_app_orders SET tracking_sent_at = NOW() WHERE id = $1', [orderId]);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Actualizar estado de orden
app.put('/api/pedidos/admin/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (status) {
      if (!ORDER_STATUSES.has(status)) {
        return res.status(400).json({ status: 'error', error: 'Estado de pedido inválido' });
      }
      if (['Asignado externo', 'Entregado al operador externo'].includes(status)) {
        return res.status(400).json({
          status: 'error',
          error: 'Usa la acción de entrega externa para registrar empresa, costo y auditoría.',
        });
      }
      if (status === 'Cancelado') {
        try {
          const result = await deliveryOrderService.cancelOrder({
            orderId: Number(id),
            actor: req.user,
            idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
            reason: req.body.reason || 'Cancelado desde el panel administrativo',
          });
          if (result.order?.delivery_user_id) {
            deliveryRealtime.sendPush({
              userId: result.order.delivery_user_id,
              title: 'Pedido cancelado',
              body: `El pedido #${id} fue cancelado`,
              url: '/',
            }).catch((pushError) => console.error('Error enviando push de cancelación:', pushError));
          }
          return res.json({ status: 'ok', order: result.order, replayed: result.replayed });
        } catch (error) {
          return res.status(error.statusCode || 500).json({
            status: 'error', code: error.code || 'ORDER_CANCEL_FAILED',
            error: error.statusCode ? error.message : 'No fue posible cancelar el pedido',
            details: error.details,
          });
        }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: currentRows } = await client.query(
          'SELECT * FROM pedidos_app_orders WHERE id = $1 FOR UPDATE',
          [id]
        );
        if (!currentRows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'error', error: 'Pedido no encontrado' });
        }

        const currentOrder = currentRows[0];
        const ownDelivery = String(currentOrder.delivery_type || '').toLowerCase() === 'domicilio'
          && !String(currentOrder.delivery_provider_type || 'own').startsWith('external_');
        
        const isAdmin = ['Admin', 'Administrador', 'Super Administrador', 'super_admin'].includes(req.user?.role || req.user?.role_name || '');

        if (ownDelivery && ['En camino', 'Entregado'].includes(status) && !isAdmin) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'error',
            code: 'DELIVERY_DOMAIN_ACTION_REQUIRED',
            error: status === 'En camino'
              ? 'El domiciliario debe confirmar que inició la entrega desde Delivery.'
              : 'La entrega debe finalizarse desde Delivery con GPS o con una excepción de geocerca autorizada.',
          });
        }
        if (req.body.version != null && Number(req.body.version) !== Number(currentOrder.version || 0)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'error', code: 'ORDER_VERSION_CONFLICT',
            error: 'El pedido cambió en otro dispositivo. Actualiza la información antes de continuar.',
            currentVersion: Number(currentOrder.version || 0),
          });
        }
        if (!canTransitionOrder(currentOrder.status, status)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            status: 'error',
            code: 'INVALID_ORDER_TRANSITION',
            error: `No se puede cambiar el pedido de ${currentOrder.status} a ${status}.`,
          });
        }
        const willBeFinal = FINAL_ORDER_STATUSES.has(status);
        if (currentOrder.status !== 'Cancelado' && status === 'Cancelado') {
          await releaseProductStock(client, currentOrder, req.user?.username);
        } else if (currentOrder.status === 'Cancelado' && status !== 'Cancelado') {
          const normalized = await normalizeOrderCart(client, currentOrder.cart_json, { activeOnly: false });
          await reserveProductStock(client, normalized, currentOrder.id, req.user?.username);
        }

        const deliveryStatus = status === 'Cancelado'
          ? 'Cancelado'
          : willBeFinal
            ? 'Entregado'
            : ['Cancelado', 'Entregado'].includes(currentOrder.delivery_status) ? 'Pendiente' : null;
        const { rows } = await client.query(
          `UPDATE pedidos_app_orders
           SET status = $1,
               updated_at = NOW(),
               completed_at = CASE WHEN $2 THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
               delivered_at = CASE WHEN $2 THEN COALESCE(delivered_at, NOW()) ELSE NULL END,
               delivery_status = COALESCE($4::varchar, delivery_status),
               delivery_completed_at = CASE WHEN $4::varchar = 'Entregado' THEN COALESCE(delivery_completed_at, NOW()) ELSE delivery_completed_at END,
               version = version + 1
           WHERE id = $3 RETURNING *`,
          [status, willBeFinal, id, deliveryStatus]
        );
        if (rows[0].delivery_user_id && ['Cancelado', 'Entregado'].includes(rows[0].delivery_status)) {
          await client.query(`
            UPDATE pedidos_app_delivery_profiles
            SET availability_status = 'Libre', updated_at = NOW()
            WHERE user_id = $1
          `, [rows[0].delivery_user_id]);
        }
        if (status === 'Cancelado' && String(rows[0].delivery_provider_type || '').startsWith('external_')) {
          await client.query(`
            INSERT INTO pedidos_app_delivery_events
              (order_id,event_type,provider_type,company_id,actor_user_id,actor_name,external_cost,notes)
            VALUES ($1,'cancelled',$2,$3,$4,$5,$6,'Entrega externa cancelada desde el ERP')
          `, [id, rows[0].delivery_provider_type, rows[0].external_delivery_company_id, req.user.id, req.user.username || null, rows[0].external_delivery_cost]);
        }
        await deliveryOrderService.appendDomainEvent(
          client,
          status === 'Listo' && String(rows[0].delivery_type || '').toLowerCase() === 'domicilio'
            ? 'order_available'
            : 'order_status_changed',
          'order',
          rows[0].id,
          {
            orderId: rows[0].id,
            orderStatus: rows[0].status,
            deliveryStatus: rows[0].delivery_status,
            version: Number(rows[0].version || 0),
          },
        );
        await client.query('COMMIT');
        if (status === 'Cancelado' && rows[0].delivery_user_id) {
          deliveryRealtime.sendPush({
            userId: rows[0].delivery_user_id,
            title: 'Pedido cancelado',
            body: `El pedido #${id} fue cancelado`,
            url: '/',
          }).catch((pushError) => console.error('Error enviando push de cancelación:', pushError));
        } else if (rows[0].delivery_user_id) {
          deliveryRealtime.sendPush({
            userId: rows[0].delivery_user_id,
            title: `Pedido #${id} actualizado`,
            body: `El estado del pedido cambió a ${status}`,
            url: `/pedidos/${id}`,
          }).catch((pushError) => console.error('Error enviando push de estado:', pushError));
        } else if (status === 'Listo' && String(rows[0].delivery_type || '').toLowerCase() === 'domicilio') {
          deliveryRealtime.sendPush({
            title: 'Nuevo pedido disponible',
            body: `El pedido #${id} está listo para entregar`,
            url: '/',
          }).catch((pushError) => console.error('Error enviando push de pedido disponible:', pushError));
        }
        res.json({ status: 'ok', order: rows[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      res.status(400).json({ status: 'error', error: 'No se enviaron datos para actualizar' });
    }
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

// Editar pedido completo (carrito, total, cliente)
app.put('/api/pedidos/admin/orders/:id/edit', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { cart, customer } = req.body;
    if (!customer || typeof customer !== 'object') {
      return res.status(400).json({ status: 'error', error: 'Los datos del cliente son obligatorios' });
    }
    await client.query('BEGIN');
    const { rows: currentRows } = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!currentRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    const currentOrder = currentRows[0];
    if (currentOrder.status !== 'Cancelado') await releaseProductStock(client, currentOrder, req.user?.username);
    const normalized = await normalizeOrderCart(client, cart, { activeOnly: false });
    const cartStr = JSON.stringify(normalized.cart);
    const customDateStr = (customer && customer.created_at) || req.body.created_at;
    const customDate = parseColombiaTimestamp(customDateStr);

    if (customDate && await isDateClosed(customDate)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'El período contable para esta fecha ya está cerrado.' });
    }

    // Format phone to always start with 57
    let formattedPhone = customer.phone ? customer.phone.replace(/\D/g, '') : '';
    if (formattedPhone.length === 10) {
      formattedPhone = '57' + formattedPhone;
    } else if (formattedPhone.length > 10 && !formattedPhone.startsWith('57')) {
      formattedPhone = '57' + formattedPhone;
    }

    const deliveryLocation = normalizeDeliveryLocation(customer);
    const isDelivery = String(customer.deliveryType || '').toLowerCase() === 'domicilio';
    const settingsResult = await client.query('SELECT COALESCE(delivery_cost, 0)::integer AS delivery_cost FROM pedidos_app_settings WHERE id = 1');
    const deliveryFee = isDelivery ? Math.max(0, Number(settingsResult.rows[0]?.delivery_cost || 0)) : 0;
    const orderTotal = normalized.total + deliveryFee;
    const { rows } = await client.query(
      `UPDATE pedidos_app_orders 
       SET cart_json = $1, total = $2, customer_name = $3, customer_phone = $4, address = $5,
           delivery_type = $6, payment_method = $7, barrio = $8, source = $9,
           created_at = COALESCE($10, created_at), notes = COALESCE($12, notes),
           voucher_reference = $13,
           delivery_reference = $14, delivery_latitude = $15, delivery_longitude = $16,
           delivery_place_id = $17, delivery_location_adjusted = $18,
           delivery_apartment = $19, delivery_tower = $20, delivery_floor = $21,
           delivery_fee = $22
       WHERE id = $11 RETURNING *`,
      [
        cartStr, orderTotal, customer.name, formattedPhone, customer.address,
        customer.deliveryType, customer.paymentMethod, customer.barrio || '',
        req.body.source || customer.source || 'Web', customDate, id, customer.notes || '',
        customer.voucher_reference || '',
        isDelivery ? String(customer.reference || customer.deliveryReference || '').trim().slice(0, 500) || null : null,
        isDelivery ? deliveryLocation.latitude : null,
        isDelivery ? deliveryLocation.longitude : null,
        isDelivery ? String(customer.placeId || customer.googlePlaceId || '').trim().slice(0, 255) || null : null,
        isDelivery && customer.locationAdjusted === true,
        isDelivery ? String(customer.apartment || '').trim().slice(0, 50) || null : null,
        isDelivery ? String(customer.tower || '').trim().slice(0, 50) || null : null,
        isDelivery ? String(customer.floor || '').trim().slice(0, 30) || null : null,
        deliveryFee,
      ]
    );
    if (currentOrder.status !== 'Cancelado') await reserveProductStock(client, normalized, id, req.user?.username);
    await client.query('COMMIT');
    res.json({ status: 'ok', order: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error editing order:', error);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  } finally { client.release(); }
});

// Eliminar orden
app.delete('/api/pedidos/admin/orders/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (rows[0].status !== 'Cancelado') await releaseProductStock(client, rows[0], req.user?.username);
    await client.query('DELETE FROM pedidos_app_orders WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ status: 'ok' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting order:', error);
    res.status(500).json({ status: 'error', error: error.message });
  } finally { client.release(); }
});

// ================= PRODUCTOS =================
// Obtener todos los productos admin
app.get('/api/pedidos/admin/products', authenticateToken, async (req, res) => {
  try {
    if (!dbUrl) return res.json({ status: 'ok', products: [] });
    const { rows } = await pool.query(`
      SELECT id, title, description, price, category, status, is_active, is_featured,
             stock, barcode, track_stock, low_stock_threshold, inventory_unit, inventory_unit_cost,
             rating_sum, rating_count, created_at, updated_at, image IS NOT NULL AS has_image
      FROM pedidos_app_products ORDER BY id DESC
    `);
    res.json({ status: 'ok', products: rows.map((product) => productForResponse(req, product)) });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Crear producto
app.post('/api/pedidos/admin/products', authenticateToken, async (req, res) => {
  try {
    const { title, description, price, category, image, status, is_featured, stock,
      barcode, track_stock, low_stock_threshold, inventory_unit, inventory_unit_cost } = req.body;
    if (!title?.trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: 'Nombre y precio válido son obligatorios' });
    }
    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_products
       (title, description, price, category, image, status, is_featured, stock, barcode,
        track_stock, low_stock_threshold, inventory_unit, inventory_unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [title.trim(), description, Number(price), category, image, status || 'Activo', Boolean(is_featured),
        Number(stock) || 0, barcode?.trim() || null, Boolean(track_stock), Number(low_stock_threshold) || 5,
        inventory_unit || 'unidad', Number(inventory_unit_cost) || 0]
    );
    res.status(201).json({ status: 'ok', product: productForResponse(req, { ...rows[0], has_image: Boolean(rows[0].image) }) });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(error.code === '23505' ? 409 : 500).json({ status: 'error', error: error.code === '23505' ? 'El código de barras ya está asignado' : error.message });
  }
});

// Actualizar producto
app.put('/api/pedidos/admin/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, category, image, status, is_featured, stock,
      barcode, track_stock, low_stock_threshold, inventory_unit, inventory_unit_cost } = req.body;
    const keepStoredImage = isManagedMediaUrl(image, 'products', id);
    const { rows } = keepStoredImage
      ? await pool.query(
        `UPDATE pedidos_app_products
         SET title=$1, description=$2, price=$3, category=$4, status=$5,
             is_featured=$6, stock=$7, barcode=$8, track_stock=$9,
             low_stock_threshold=$10, inventory_unit=$11, inventory_unit_cost=$12, updated_at=NOW()
         WHERE id::text=$13 RETURNING *`,
        [title, description, price, category, status, is_featured, Number(stock) || 0,
          barcode?.trim() || null, Boolean(track_stock), Number(low_stock_threshold) || 5,
          inventory_unit || 'unidad', Number(inventory_unit_cost) || 0, id]
      )
      : await pool.query(
        `UPDATE pedidos_app_products
         SET title=$1, description=$2, price=$3, category=$4, image=$5, status=$6,
             is_featured=$7, stock=$8, barcode=$9, track_stock=$10,
             low_stock_threshold=$11, inventory_unit=$12, inventory_unit_cost=$13, updated_at=NOW()
         WHERE id::text=$14 RETURNING *`,
        [title, description, price, category, image, status, is_featured, Number(stock) || 0,
          barcode?.trim() || null, Boolean(track_stock), Number(low_stock_threshold) || 5,
          inventory_unit || 'unidad', Number(inventory_unit_cost) || 0, id]
      );
    if (!rows.length) return res.status(404).json({ status: 'error', error: 'Producto no encontrado' });
    res.json({ status: 'ok', product: productForResponse(req, { ...rows[0], has_image: Boolean(rows[0].image) }) });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(error.code === '23505' ? 409 : 500).json({ status: 'error', error: error.code === '23505' ? 'El código de barras ya está asignado' : error.message });
  }
});

// Eliminar producto
app.delete('/api/pedidos/admin/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_products WHERE id::text = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

const barcodeLookupCache = new Map();
app.get('/api/pedidos/admin/products/lookup-barcode/:code', authenticateToken, inventoryLookupLimiter, async (req, res) => {
  const code = String(req.params.code || '').replace(/\D/g, '');
  if (!/^\d{8,14}$/.test(code)) return res.status(400).json({ error: 'El código debe contener entre 8 y 14 dígitos' });
  const cached = barcodeLookupCache.get(code);
  if (cached && cached.expiresAt > Date.now()) return res.json({ status: 'ok', source: 'cache', product: cached.product });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`https://world.openfoodfacts.org/api/v3/product/${code}?fields=code,product_name,brands,quantity,image_front_url,categories`, {
      headers: { 'User-Agent': process.env.OPEN_FOOD_FACTS_USER_AGENT || 'DistritoBG/1.0 (inventario; contacto@distritobg.app)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Producto no encontrado en Open Food Facts' });
    const data = await response.json();
    const source = data.product || data;
    const product = {
      barcode: code,
      title: source.product_name || '',
      brand: source.brands || '',
      quantity: source.quantity || '',
      image: source.image_front_url || '',
      category: String(source.categories || '').split(',')[0].trim(),
    };
    barcodeLookupCache.set(code, { product, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    res.json({ status: 'ok', source: 'open-food-facts', product, advisory: true });
  } catch (error) {
    res.status(502).json({ error: error.name === 'AbortError' ? 'La consulta externa tardó demasiado' : 'No fue posible consultar el código de barras' });
  }
});

app.get('/api/pedidos/admin/product-stock', authenticateToken, requirePermission('Inventario', 'ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, category, status, stock, barcode, track_stock, low_stock_threshold,
             inventory_unit, inventory_unit_cost, updated_at
      FROM pedidos_app_products
      ORDER BY (track_stock AND COALESCE(stock, 0) <= low_stock_threshold) DESC, title
    `);
    res.json({ status: 'ok', data: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/admin/product-stock/:id/movements', authenticateToken, requirePermission('Inventario', 'editar'), async (req, res) => {
  const client = await pool.connect();
  try {
    const movementType = String(req.body.movement_type || '').toUpperCase();
    const quantity = Number(req.body.quantity);
    if (!['ENTRADA', 'SALIDA', 'AJUSTE'].includes(movementType) || !Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'Movimiento o cantidad inválida' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, stock FROM pedidos_app_products WHERE id::text=$1 FOR UPDATE', [req.params.id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const current = Number(rows[0].stock) || 0;
    const next = movementType === 'AJUSTE' ? quantity : movementType === 'ENTRADA' ? current + quantity : current - quantity;
    if (next < 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'La salida supera las existencias disponibles' });
    }
    await client.query(`
      UPDATE pedidos_app_products SET stock=$1, track_stock=TRUE, updated_at=NOW() WHERE id=$2
    `, [next, rows[0].id]);
    await client.query(`
      INSERT INTO pedidos_app_product_stock_movements
        (product_id, movement_type, quantity, balance_after, reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [rows[0].id, movementType, next - current, next, String(req.body.reason || '').slice(0, 500), req.user.username]);
    await client.query('COMMIT');
    res.json({ status: 'ok', stock: next });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

app.patch('/api/pedidos/admin/product-stock/:id', authenticateToken, requirePermission('Inventario', 'editar'), async (req, res) => {
  try {
    const { barcode, track_stock, low_stock_threshold, inventory_unit, inventory_unit_cost } = req.body;
    const threshold = Number(low_stock_threshold);
    const unitCost = Number(inventory_unit_cost);
    if (!Number.isInteger(threshold) || threshold < 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      return res.status(400).json({ error: 'Umbral o costo inválido' });
    }
    const { rows } = await pool.query(`
      UPDATE pedidos_app_products
      SET barcode=$1, track_stock=$2, low_stock_threshold=$3,
          inventory_unit=$4, inventory_unit_cost=$5, updated_at=NOW()
      WHERE id::text=$6 RETURNING id, stock
    `, [String(barcode || '').trim() || null, Boolean(track_stock), threshold, String(inventory_unit || 'unidad').slice(0, 30), Math.round(unitCost), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ status: 'ok', data: rows[0] });
  } catch (error) {
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'El código de barras ya está asignado a otro producto' : error.message });
  }
});

// ================= CONFIGURACION =================
const SETTINGS_FIELDS = new Set([
  'whatsapp_number', 'nequi_number', 'bancolombia_number', 'restaurant_name',
  'description', 'phone', 'email', 'address', 'schedule', 'logo', 'prep_time',
  'min_order', 'delivery_cost', 'max_distance', 'delivery_schedule',
  'default_order_type', 'payment_efectivo', 'payment_nequi', 'payment_daviplata',
  'payment_tarjeta', 'payment_transferencia', 'payment_pse', 'instagram',
  'facebook', 'tiktok', 'welcome_message', 'currency', 'timezone', 'language',
  'date_format', 'time_format', 'web_primary_color', 'web_background_color',
  'web_surface_color', 'web_text_color', 'admin_primary_color', 'admin_background_color',
  'admin_surface_color', 'admin_text_color', 'store_latitude', 'store_longitude',
  'kitchen_address', 'kitchen_place_id', 'delivery_completion_radius_meters',
  'notification_voice', 'notification_language', 'web_logo', 'web_page_title',
  'web_hero_title', 'web_hero_subtitle', 'web_font_family', 'web_card_style',
  'admin_logo', 'admin_page_title', 'admin_sidebar_title', 'admin_font_family',
  'admin_density', 'delivery_logo', 'delivery_page_title', 'delivery_heading',
  'delivery_subtitle', 'delivery_font_family', 'delivery_card_style',
  'delivery_primary_color', 'delivery_background_color', 'delivery_surface_color',
  'delivery_text_color', 'gps_delivery_interval_seconds', 'gps_free_interval_seconds',
  'presence_heartbeat_interval_seconds', 'presence_timeout_seconds',
  'gps_max_age_seconds', 'gps_max_accuracy_meters', 'offline_location_queue_limit'
  , 'default_max_driver_capacity', 'sse_reconnect_initial_ms', 'sse_reconnect_max_ms'
]);

const COLOR_SETTING_FIELDS = new Set([...SETTINGS_FIELDS].filter((key) => key.endsWith('_color')));

app.get('/api/pedidos/admin/settings', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_settings WHERE id = 1');
    if (rows.length === 0) {
      await pool.query('INSERT INTO pedidos_app_settings (id) VALUES (1)');
      const { rows: newRows } = await pool.query('SELECT * FROM pedidos_app_settings WHERE id = 1');
      return res.json({ status: 'ok', settings: settingsForResponse(req, newRows[0]) });
    }
    res.json({ status: 'ok', settings: settingsForResponse(req, rows[0]) });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/settings', authenticateToken, async (req, res) => {
  try {
    const data = { ...req.body };
    if (typeof data.logo === 'string' && data.logo.includes('/api/pedidos/media/settings-logo')) delete data.logo;
    ['web', 'admin', 'delivery'].forEach((surface) => {
      const key = `${surface}_logo`;
      if (typeof data[key] === 'string' && data[key].includes(`/api/pedidos/media/settings-logo/${surface}`)) delete data[key];
    });
    const requestedKeys = Object.keys(data).filter(k => k !== 'id' && k !== 'updated_at');
    const invalidKeys = requestedKeys.filter(k => !SETTINGS_FIELDS.has(k));
    if (invalidKeys.length) {
      return res.status(400).json({ status: 'error', error: 'La configuración contiene campos no permitidos.' });
    }
    const invalidColors = requestedKeys.filter((key) => COLOR_SETTING_FIELDS.has(key) && !/^#[0-9A-Fa-f]{6}$/.test(String(data[key] || '')));
    if (invalidColors.length) return res.status(400).json({ status: 'error', error: 'Los colores deben usar formato hexadecimal #RRGGBB.' });
    if (requestedKeys.includes('kitchen_address') && String(data.kitchen_address || '').length > 500) {
      return res.status(400).json({ status: 'error', error: 'La dirección de la cocina es demasiado larga.' });
    }
    if (requestedKeys.includes('kitchen_place_id') && String(data.kitchen_place_id || '').length > 255) {
      return res.status(400).json({ status: 'error', error: 'El identificador de Google Maps no es válido.' });
    }
    if (requestedKeys.includes('delivery_completion_radius_meters')) {
      const completionRadius = Number(data.delivery_completion_radius_meters);
      if (!Number.isInteger(completionRadius) || completionRadius < 50 || completionRadius > 500) {
        return res.status(400).json({ status: 'error', error: 'El radio para finalizar debe estar entre 50 y 500 metros.' });
      }
    }
    const boundedDeliverySettings = {
      gps_delivery_interval_seconds: [3, 60],
      gps_free_interval_seconds: [15, 300],
      presence_heartbeat_interval_seconds: [10, 120],
      presence_timeout_seconds: [30, 600],
      gps_max_age_seconds: [30, 900],
      gps_max_accuracy_meters: [20, 1000],
      offline_location_queue_limit: [100, 20000],
      default_max_driver_capacity: [1, 5],
      sse_reconnect_initial_ms: [500, 10000],
      sse_reconnect_max_ms: [5000, 120000],
    };
    const invalidDeliverySetting = requestedKeys.find((key) => {
      const bounds = boundedDeliverySettings[key];
      if (!bounds) return false;
      const value = Number(data[key]);
      if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1]) return true;
      data[key] = value;
      return false;
    });
    if (invalidDeliverySetting) {
      const [minimum, maximum] = boundedDeliverySettings[invalidDeliverySetting];
      return res.status(400).json({ status: 'error', error: `${invalidDeliverySetting} debe estar entre ${minimum} y ${maximum}.` });
    }
    if (requestedKeys.some((key) => ['sse_reconnect_initial_ms', 'sse_reconnect_max_ms'].includes(key))) {
      const initial = Number(data.sse_reconnect_initial_ms ?? 1500);
      const maximum = Number(data.sse_reconnect_max_ms ?? 30000);
      if (maximum < initial) return res.status(400).json({ status: 'error', error: 'El máximo de reconexión SSE no puede ser menor que el intervalo inicial.' });
    }
    if (requestedKeys.includes('notification_voice')
        && !['female-clear', 'female-energetic', 'female-calm', 'male', 'system'].includes(data.notification_voice)) {
      return res.status(400).json({ status: 'error', error: 'El tipo de voz seleccionado no es válido.' });
    }
    if (requestedKeys.includes('notification_language')
        && !['es-CO', 'es-MX', 'es-ES', 'en-US', 'pt-BR'].includes(data.notification_language)) {
      return res.status(400).json({ status: 'error', error: 'El idioma de las alertas no es válido.' });
    }
    const fontKeys = ['web_font_family', 'admin_font_family', 'delivery_font_family'];
    if (requestedKeys.some((key) => fontKeys.includes(key) && !['modern', 'friendly', 'classic', 'system'].includes(data[key]))) {
      return res.status(400).json({ status: 'error', error: 'La familia tipográfica seleccionada no es válida.' });
    }
    if ((requestedKeys.includes('web_card_style') && !['rounded', 'compact', 'outlined'].includes(data.web_card_style))
        || (requestedKeys.includes('delivery_card_style') && !['rounded', 'compact', 'outlined'].includes(data.delivery_card_style))) {
      return res.status(400).json({ status: 'error', error: 'El estilo de tarjetas no es válido.' });
    }
    if (requestedKeys.includes('admin_density') && !['comfortable', 'compact'].includes(data.admin_density)) {
      return res.status(400).json({ status: 'error', error: 'La densidad del panel no es válida.' });
    }
    const textLimits = {
      web_page_title: 120, web_hero_title: 160, web_hero_subtitle: 300,
      admin_page_title: 120, admin_sidebar_title: 120,
      delivery_page_title: 120, delivery_heading: 160, delivery_subtitle: 300,
    };
    const invalidText = requestedKeys.find((key) => textLimits[key] && String(data[key] || '').trim().length > textLimits[key]);
    if (invalidText) return res.status(400).json({ status: 'error', error: `El campo ${invalidText} supera el máximo permitido.` });
    const latitude = Number(data.store_latitude);
    const longitude = Number(data.store_longitude);
    const hasLatitude = data.store_latitude !== null && data.store_latitude !== undefined && data.store_latitude !== '';
    const hasLongitude = data.store_longitude !== null && data.store_longitude !== undefined && data.store_longitude !== '';
    if ((requestedKeys.includes('store_latitude') && (!hasLatitude || !Number.isFinite(latitude) || latitude < -90 || latitude > 90))
        || (requestedKeys.includes('store_longitude') && (!hasLongitude || !Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
      return res.status(400).json({ status: 'error', error: 'Las coordenadas de la cocina no son válidas.' });
    }
    const keys = requestedKeys;
    if (keys.length === 0) return res.json({ status: 'ok', message: 'No fields to update' });

    const setString = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const values = keys.map(k => data[k]);

    const query = `UPDATE pedidos_app_settings SET ${setString}, updated_at = NOW() WHERE id = 1 RETURNING *`;
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(query, values));
      await client.query(`
        INSERT INTO pedidos_app_audit_logs
          (user_id,username_attempted,module,action,details,request_data)
        VALUES ($1,$2,'Configuracion','Actualizar configuración','Configuración central actualizada',$3::jsonb)
      `, [req.user.id, req.user.username || null, JSON.stringify({ changedFields: keys, requestId: req.requestId })]);
      await deliveryOrderService.appendDomainEvent(client, 'settings_updated', 'settings', 1, {
        changedFields: keys, actorUserId: req.user.id, requestId: req.requestId,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    res.json({ status: 'ok', settings: settingsForResponse(req, rows[0]) });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});


// ================= INVENTARIO =================

app.get('/api/pedidos/admin/inventory', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, COALESCE(SUM(l.available_quantity), 0) AS stock,
        COALESCE(SUM(l.available_quantity * l.unit_cost) / NULLIF(SUM(l.available_quantity), 0), 0) AS unit_cost,
        MAX(m.created_at) AS last_movement_at
      FROM pedidos_app_inventory i
      LEFT JOIN pedidos_app_inventory_lots l ON l.inventory_id = i.id AND l.branch_id = 1 AND l.status = 'Disponible'
      LEFT JOIN pedidos_app_inventory_movements m ON m.inventory_id = i.id
      GROUP BY i.id ORDER BY i.name ASC
    `);
    res.json({ status: 'ok', items: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/inventory', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { image, name, type, category, unit, min_stock, purchase_unit, consumption_unit,
      conversion_factor, max_stock, status, observations } = req.body;
    if (!name?.trim()) return res.status(400).json({ status: 'error', error: 'El nombre es requerido' });
    await client.query('BEGIN');
    const automaticSku = await generateIngredientSku(client, category);
    const { rows } = await client.query(
      `INSERT INTO pedidos_app_inventory
       (image, name, type, category, unit, min_stock, sku, purchase_unit, consumption_unit, conversion_factor, max_stock, status, observations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [image || null, name.trim(), type || 'Ingrediente', category || 'General', consumption_unit || unit || 'Unidad',
      Number(min_stock) || 0, automaticSku, purchase_unit || unit || 'Unidad', consumption_unit || unit || 'Unidad',
      Number(conversion_factor) || 1, max_stock || null, status || 'Activo', observations || null]
    );
    await client.query('COMMIT');
    res.json({ status: 'ok', item: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/pedidos/admin/inventory/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { image, name, type, category, unit, min_stock, sku, purchase_unit, consumption_unit,
      conversion_factor, max_stock, status, observations } = req.body;
    const { rows } = await pool.query(
      `UPDATE pedidos_app_inventory 
       SET image=$1, name=$2, type=$3, category=$4, unit=$5, min_stock=$6, sku=COALESCE(sku, $7), purchase_unit=$8,
           consumption_unit=$9, conversion_factor=$10, max_stock=$11, status=$12, observations=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [image || null, name, type || 'Ingrediente', category || 'General', consumption_unit || unit || 'Unidad', Number(min_stock) || 0,
      sku || null, purchase_unit || unit || 'Unidad', consumption_unit || unit || 'Unidad', Number(conversion_factor) || 1,
      max_stock || null, status || 'Activo', observations || null, id]
    );
    res.json({ status: 'ok', item: rows[0] });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.delete('/api/pedidos/admin/inventory/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_inventory WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/inventory/:id/movement', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { movement_type, quantity, notes, unit_cost } = req.body;
    const numericQuantity = Number(quantity);
    if (!['IN', 'OUT'].includes(movement_type) || !Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ status: 'error', error: 'Solo se permiten ajustes positivos o negativos con una cantidad mayor a cero.' });
    }

    // Iniciar transacción
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ingredients } = await client.query('SELECT * FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE', [id]);
      if (!ingredients.length) throw new Error('Ingrediente no encontrado.');
      if (movement_type === 'IN') {
        const cost = Number(unit_cost || ingredients[0].unit_cost || 0);
        const lotCode = `AJU-${id}-${Date.now()}`;
        const { rows: lots } = await client.query(
          `INSERT INTO pedidos_app_inventory_lots
           (inventory_id, lot_code, source_quantity, source_unit, initial_quantity, available_quantity, unit_cost)
           VALUES ($1,$2,$3,$4,$3,$3,$5) RETURNING *`,
          [id, lotCode, numericQuantity, ingredients[0].consumption_unit || ingredients[0].unit, cost]
        );
        await createInventoryMovement(client, {
          inventoryId: id, lotId: lots[0].id, type: 'Ajuste positivo', quantity: numericQuantity,
          unitCost: cost, balanceAfter: numericQuantity, referenceType: 'Ajuste', notes, createdBy: req.user?.username
        });
      } else {
        let pending = numericQuantity;
        const { rows: lots } = await client.query(`
          SELECT * FROM pedidos_app_inventory_lots WHERE inventory_id = $1 AND branch_id = 1
          AND status = 'Disponible' AND available_quantity > 0 ORDER BY created_at, id FOR UPDATE`, [id]);
        for (const lot of lots) {
          if (pending <= 0) break;
          const used = Math.min(pending, Number(lot.available_quantity));
          const balance = Number(lot.available_quantity) - used;
          await client.query('UPDATE pedidos_app_inventory_lots SET available_quantity = $1, status = CASE WHEN $1 = 0 THEN \'Agotado\' ELSE \'Disponible\' END WHERE id = $2', [balance, lot.id]);
          await createInventoryMovement(client, {
            inventoryId: id, lotId: lot.id, type: 'Ajuste negativo', quantity: -used,
            unitCost: lot.unit_cost, balanceAfter: balance, referenceType: 'Ajuste', notes, createdBy: req.user?.username
          });
          pending -= used;
        }
        if (pending > 0) { const error = new Error('No hay existencia suficiente para el ajuste.'); error.statusCode = 409; throw error; }
      }

      await client.query('COMMIT');
      res.json({ status: 'ok' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

app.get('/api/pedidos/admin/inventory/:id/movements', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM pedidos_app_inventory_movements WHERE inventory_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ status: 'ok', movements: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});
// ================= COMPRAS =================
app.get('/api/pedidos/admin/purchases', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_purchases ORDER BY created_at DESC');
    res.json({ status: 'ok', purchases: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/purchases', authenticateToken, async (req, res) => {
  const { invoice_number, supplier, purchase_date, total_amount, iva_amount, notes, items } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Crear compra
    const { rows: purchaseRows } = await client.query(
      `INSERT INTO pedidos_app_purchases (invoice_number, supplier, purchase_date, total_amount, iva_amount, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [invoice_number, supplier, purchase_date || new Date(), total_amount, iva_amount || 0, notes]
    );
    const purchase = purchaseRows[0];

    // 2. Procesar ítems
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item.inventory_id || Number(item.quantity) <= 0 || Number(item.total_cost) < 0) {
        const error = new Error('Cada compra debe tener ingrediente, cantidad y costo válidos.');
        error.statusCode = 400;
        throw error;
      }
      const { rows: ingredients } = await client.query(
        'SELECT id, purchase_unit, consumption_unit, conversion_factor FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE',
        [item.inventory_id]
      );
      if (!ingredients.length) throw new Error(`Ingrediente #${item.inventory_id} no encontrado.`);
      const ingredient = ingredients[0];
      const factor = Number(item.conversion_factor || ingredient.conversion_factor || 1);
      const usableQuantity = Number(item.usable_quantity || (Number(item.quantity) * factor));
      if (!Number.isFinite(usableQuantity) || usableQuantity <= 0) throw new Error('El rendimiento útil debe ser mayor a cero.');
      const totalWithTax = Number(item.total_cost) * (1 + Number(item.iva_amount || 0) / 100);
      const unitCost = totalWithTax / usableQuantity;
      const lotCode = item.lot_code || `${String(ingredient.sku || 'LOT').replace(/\s+/g, '-').toUpperCase()}-${String(purchase.purchase_date).replace(/-/g, '')}-${String(index + 1).padStart(3, '0')}`;
      // Registrar detalle de compra
      const { rows: purchaseItemRows } = await client.query(
        `INSERT INTO pedidos_app_purchase_items (purchase_id, inventory_id, quantity, unit_cost, total_cost, iva_amount, lot_code, expiration_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [purchase.id, item.inventory_id, item.quantity, item.unit_cost, item.total_cost, item.iva_amount || 0, lotCode, item.expiration_date || null]
      );
      const purchaseItemId = purchaseItemRows[0]?.id;
      const { rows: lotRows } = await client.query(
        `INSERT INTO pedidos_app_inventory_lots
           (inventory_id, purchase_item_id, lot_code, source_quantity, source_unit, initial_quantity, available_quantity, unit_cost, expiration_date)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING *`,
        [item.inventory_id, purchaseItemId || null, lotCode, item.quantity, ingredient.purchase_unit || item.unit,
          usableQuantity, unitCost, item.expiration_date || null]
      );
      await createInventoryMovement(client, {
        inventoryId: item.inventory_id, lotId: lotRows[0].id, type: 'Compra', quantity: usableQuantity,
        unitCost, balanceAfter: usableQuantity, referenceType: 'Compra', referenceId: purchase.id,
        notes: `Compra: ${invoice_number || 'S/N'} · Lote ${lotCode}`, createdBy: req.user?.username
      });
    }

    await client.query('COMMIT');
    res.json({ status: 'ok', purchase });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/pedidos/admin/purchases/:id/items', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT pi.*, i.name, i.unit 
       FROM pedidos_app_purchase_items pi
       JOIN pedidos_app_inventory i ON pi.inventory_id = i.id
       WHERE pi.purchase_id = $1`,
      [id]
    );
    res.json({ status: 'ok', items: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/purchases/:id', authenticateToken, async (req, res) => {
  return res.status(409).json({
    status: 'error',
    error: 'Las compras contabilizadas no se editan. Registra un ajuste o una compra de corrección para conservar el Kardex.'
  });
  /* Historial anterior: se conserva temporalmente como referencia, pero no se ejecuta.
  const { id } = req.params;
  const { invoice_number, supplier, purchase_date, total_amount, iva_amount, notes, items } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Obtener ítems antiguos para revertir stock
    const { rows: oldItems } = await client.query('SELECT inventory_id, quantity FROM pedidos_app_purchase_items WHERE purchase_id = $1', [id]);
    for (const old of oldItems) {
      await client.query(
        `UPDATE pedidos_app_inventory SET stock = stock - $1, updated_at = NOW() WHERE id = $2`,
        [old.quantity, old.inventory_id]
      );
    }
    
    // 2. Eliminar ítems antiguos
    await client.query('DELETE FROM pedidos_app_purchase_items WHERE purchase_id = $1', [id]);
    
    // 3. Actualizar datos de compra
    await client.query(
      `UPDATE pedidos_app_purchases 
       SET invoice_number = $1, supplier = $2, purchase_date = $3, total_amount = $4, iva_amount = $5, notes = $6
       WHERE id = $7`,
      [invoice_number, supplier, purchase_date, total_amount, iva_amount || 0, notes, id]
    );
    
    // 4. Insertar ítems nuevos y actualizar stock
      for (const item of items) {
        await client.query(
          `INSERT INTO pedidos_app_purchase_items (purchase_id, inventory_id, quantity, unit_cost, total_cost, iva_amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, item.inventory_id, item.quantity, item.unit_cost, item.total_cost, item.iva_amount || 0]
        );
        
        await client.query(
        `UPDATE pedidos_app_inventory 
         SET stock = stock + $1, unit_cost = $2, updated_at = NOW() 
         WHERE id = $3`,
        [item.quantity, item.unit_cost, item.inventory_id]
      );

      await client.query(
        `INSERT INTO pedidos_app_inventory_movements (inventory_id, movement_type, quantity, notes) 
         VALUES ($1, 'In', $2, $3)`,
        [item.inventory_id, item.quantity, `Edición Compra: ${invoice_number || 'S/N'}`]
      );
    }
    
    await client.query('COMMIT');
    res.json({ status: 'ok' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
  */
});

// --- MÓDULO DE CALIFICACIONES ---
app.post('/api/pedidos/rate', async (req, res) => {
  const { product_id, rating } = req.body;
  if (!product_id || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ status: 'error', error: 'Calificación inválida' });
  }

  try {
    const result = await pool.query(
      `UPDATE pedidos_app_products 
       SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 
       WHERE id = $2 RETURNING *`,
      [rating, product_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', error: 'Producto no encontrado' });
    }

    res.json({ status: 'ok', product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// --- MÓDULO DE ANUNCIOS Y PUSH ---
app.post('/api/pedidos/push/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Suscripción inválida' });
    }
    await pool.query(
      `INSERT INTO pedidos_app_push_subscriptions (endpoint, subscription_json, audience, updated_at)
       VALUES ($1, $2, 'customer', NOW())
       ON CONFLICT (endpoint) DO UPDATE SET subscription_json = $2, audience = 'customer', user_id = NULL, updated_at = NOW()`,
      [subscription.endpoint, JSON.stringify(subscription)]
    );
    res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error('Error guardando suscripción:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/push/subscriptions/count', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE audience = 'customer')::int AS customers,
        COUNT(*) FILTER (WHERE audience = 'delivery')::int AS drivers
      FROM pedidos_app_push_subscriptions
    `);
    res.json({ status: 'ok', count: rows[0].total, customers: rows[0].customers, drivers: rows[0].drivers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/push/send', authenticateToken, async (req, res) => {
  try {
    const { title, message, url } = req.body;
    const { rows } = await pool.query('SELECT subscription_json FROM pedidos_app_push_subscriptions');

    const payload = JSON.stringify({ title, body: message, url: url || '/' });

    const promises = rows.map(async (row) => {
      const sub = typeof row.subscription_json === 'string' ? JSON.parse(row.subscription_json) : row.subscription_json;
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM pedidos_app_push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    });

    await Promise.all(promises);
    res.json({ status: 'ok', sent: rows.length });
  } catch (err) {
    console.error('Error enviando push:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/announcement', async (req, res) => {
  try {
    const audience = req.query.returning === '1' ? 'returning' : 'new';
    const { rows } = await pool.query(`
      SELECT id, title, body, cta_label, cta_url, starts_at, ends_at,
             display_frequency, campaign_type, audience, priority, coupon_code,
             views_count, clicks_count, is_active, updated_at, image_url IS NOT NULL AS has_image
      FROM pedidos_app_announcements
      WHERE is_active = TRUE
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at IS NULL OR ends_at >= NOW())
        AND audience IN ('all', $1)
      ORDER BY priority DESC, updated_at DESC, id DESC LIMIT 1
    `, [audience]);
    if (rows.length > 0) {
      res.json({ status: 'ok', announcement: announcementForResponse(req, rows[0]) });
    } else {
      res.json({ status: 'ok', announcement: null });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/announcements/:id/view', trackingLimiter, async (req, res) => {
  try {
    await pool.query('UPDATE pedidos_app_announcements SET views_count = views_count + 1 WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch { res.status(204).end(); }
});

app.post('/api/pedidos/announcements/:id/click', trackingLimiter, async (req, res) => {
  try {
    await pool.query('UPDATE pedidos_app_announcements SET clicks_count = clicks_count + 1 WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch { res.status(204).end(); }
});

function parseCampaignInput(body = {}) {
  const campaign = {
    title: String(body.title || '').trim(), body: String(body.body || '').trim(),
    image_url: String(body.image_url || ''), cta_label: String(body.cta_label || 'Continuar').trim(),
    cta_url: String(body.cta_url || '').trim(), starts_at: body.starts_at || null,
    ends_at: body.ends_at || null, is_active: Boolean(body.is_active),
    display_frequency: ['always', 'session', 'daily'].includes(body.display_frequency) ? body.display_frequency : 'session',
    campaign_type: ['modal', 'banner'].includes(body.campaign_type) ? body.campaign_type : 'modal',
    audience: ['all', 'new', 'returning'].includes(body.audience) ? body.audience : 'all',
    priority: Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0,
    coupon_code: String(body.coupon_code || '').trim().slice(0, 50) || null,
  };
  if (!campaign.title || campaign.title.length > 255) return { error: 'El título es obligatorio y admite hasta 255 caracteres' };
  if (campaign.body.length > 1000) return { error: 'El mensaje admite hasta 1000 caracteres' };
  if (!campaign.cta_label || campaign.cta_label.length > 80) return { error: 'El texto del botón admite hasta 80 caracteres' };
  if (campaign.cta_url && !campaign.cta_url.startsWith('/') && !/^https:\/\//i.test(campaign.cta_url)) return { error: 'El enlace debe iniciar con / o usar HTTPS' };
  if (campaign.starts_at && !Number.isFinite(new Date(campaign.starts_at).getTime())) return { error: 'La fecha de inicio no es válida' };
  if (campaign.ends_at && !Number.isFinite(new Date(campaign.ends_at).getTime())) return { error: 'La fecha de cierre no es válida' };
  if (campaign.starts_at && campaign.ends_at && new Date(campaign.ends_at) <= new Date(campaign.starts_at)) return { error: 'La fecha de cierre debe ser posterior al inicio' };
  if (campaign.priority < 0 || campaign.priority > 100) return { error: 'La prioridad debe estar entre 0 y 100' };
  return { campaign };
}

app.get('/api/pedidos/admin/announcements', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, body, cta_label, cta_url, starts_at, ends_at, display_frequency,
             campaign_type, audience, priority, coupon_code, views_count, clicks_count,
             published_at, is_active, updated_at, image_url IS NOT NULL AS has_image
      FROM pedidos_app_announcements ORDER BY updated_at DESC, id DESC
    `);
    res.json({ status: 'ok', announcements: rows.map((row) => announcementForResponse(req, row)) });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

app.post('/api/pedidos/admin/announcements', authenticateToken, async (req, res) => {
  const parsed = parseCampaignInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const c = parsed.campaign;
  try {
    const { rows } = await pool.query(`
      INSERT INTO pedidos_app_announcements
        (title, image_url, body, cta_label, cta_url, starts_at, ends_at, display_frequency,
         campaign_type, audience, priority, coupon_code, is_active, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $13 THEN NOW() ELSE NULL END)
      RETURNING *
    `, [c.title, c.image_url, c.body, c.cta_label, c.cta_url, c.starts_at, c.ends_at,
      c.display_frequency, c.campaign_type, c.audience, c.priority, c.coupon_code, c.is_active]);
    res.status(201).json({ status: 'ok', announcement: announcementForResponse(req, { ...rows[0], has_image: Boolean(rows[0].image_url) }) });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

app.put('/api/pedidos/admin/announcements/:id', authenticateToken, async (req, res) => {
  const parsed = parseCampaignInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const c = parsed.campaign;
  try {
    const existing = await pool.query('SELECT id, image_url FROM pedidos_app_announcements WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Campaña no encontrada' });
    const imageUrl = isManagedMediaUrl(c.image_url, 'announcements', req.params.id) ? existing.rows[0].image_url : c.image_url;
    const { rows } = await pool.query(`
      UPDATE pedidos_app_announcements SET title=$1, image_url=$2, body=$3, cta_label=$4,
        cta_url=$5, starts_at=$6, ends_at=$7, display_frequency=$8, campaign_type=$9,
        audience=$10, priority=$11, coupon_code=$12, is_active=$13,
        published_at=CASE WHEN $13 AND published_at IS NULL THEN NOW() ELSE published_at END,
        updated_at=NOW()
      WHERE id=$14 RETURNING *
    `, [c.title, imageUrl, c.body, c.cta_label, c.cta_url, c.starts_at, c.ends_at,
      c.display_frequency, c.campaign_type, c.audience, c.priority, c.coupon_code, c.is_active, req.params.id]);
    res.json({ status: 'ok', announcement: announcementForResponse(req, { ...rows[0], has_image: Boolean(rows[0].image_url) }) });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

app.delete('/api/pedidos/admin/announcements/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM pedidos_app_announcements WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ status: 'error', error: error.message }); }
});

app.get('/api/pedidos/admin/announcement', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, body, cta_label, cta_url, starts_at, ends_at,
             display_frequency, is_active, updated_at, image_url IS NOT NULL AS has_image
      FROM pedidos_app_announcements ORDER BY updated_at DESC, id DESC LIMIT 1
    `);
    res.json({ status: 'ok', announcement: rows.length ? announcementForResponse(req, rows[0]) : null });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/announcement', authenticateToken, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const imageUrl = String(req.body.image_url || '');
  const body = String(req.body.body || '').trim();
  const ctaLabel = String(req.body.cta_label || 'Continuar').trim();
  const ctaUrl = String(req.body.cta_url || '').trim();
  const startsAt = req.body.starts_at || null;
  const endsAt = req.body.ends_at || null;
  const displayFrequency = ['always', 'session', 'daily'].includes(req.body.display_frequency)
    ? req.body.display_frequency
    : 'session';

  if (!title || title.length > 255) return res.status(400).json({ error: 'El título es obligatorio y admite hasta 255 caracteres' });
  if (body.length > 1000) return res.status(400).json({ error: 'El mensaje admite hasta 1000 caracteres' });
  if (!ctaLabel || ctaLabel.length > 80) return res.status(400).json({ error: 'El texto del botón admite hasta 80 caracteres' });
  if (ctaUrl && !ctaUrl.startsWith('/') && !/^https:\/\//i.test(ctaUrl)) {
    return res.status(400).json({ error: 'El enlace debe iniciar con / o usar HTTPS' });
  }
  if (startsAt && !Number.isFinite(new Date(startsAt).getTime())) return res.status(400).json({ error: 'La fecha de inicio no es válida' });
  if (endsAt && !Number.isFinite(new Date(endsAt).getTime())) return res.status(400).json({ error: 'La fecha de cierre no es válida' });
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    return res.status(400).json({ error: 'La fecha de cierre debe ser posterior al inicio' });
  }
  try {
    const { rows } = await pool.query('SELECT id FROM pedidos_app_announcements LIMIT 1');
    if (rows.length > 0) {
      const id = rows[0].id;
      const keepStoredImage = isManagedMediaUrl(imageUrl, 'announcements', id);
      const updated = keepStoredImage
        ? await pool.query(
          `UPDATE pedidos_app_announcements
           SET title=$1, body=$2, cta_label=$3, cta_url=$4, starts_at=$5, ends_at=$6,
               display_frequency=$7, is_active=$8, updated_at=CURRENT_TIMESTAMP
           WHERE id=$9 RETURNING *`,
          [title, body, ctaLabel, ctaUrl, startsAt, endsAt, displayFrequency, Boolean(req.body.is_active), id]
        )
        : await pool.query(
          `UPDATE pedidos_app_announcements
           SET title=$1, image_url=$2, body=$3, cta_label=$4, cta_url=$5, starts_at=$6,
               ends_at=$7, display_frequency=$8, is_active=$9, updated_at=CURRENT_TIMESTAMP
           WHERE id=$10 RETURNING *`,
          [title, imageUrl, body, ctaLabel, ctaUrl, startsAt, endsAt, displayFrequency, Boolean(req.body.is_active), id]
        );
      res.json({ status: 'ok', announcement: announcementForResponse(req, { ...updated.rows[0], has_image: Boolean(updated.rows[0].image_url) }) });
    } else {
      const inserted = await pool.query(
        `INSERT INTO pedidos_app_announcements
         (title, image_url, body, cta_label, cta_url, starts_at, ends_at, display_frequency, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [title, imageUrl, body, ctaLabel, ctaUrl, startsAt, endsAt, displayFrequency, Boolean(req.body.is_active)]
      );
      res.status(201).json({ status: 'ok', announcement: announcementForResponse(req, { ...inserted.rows[0], has_image: Boolean(inserted.rows[0].image_url) }) });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= REPORTES =================
function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftIsoDate(value, days) {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function reportPercentageChange(current, previous) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  if (!previousValue) return currentValue ? 100 : 0;
  return Math.round(((currentValue - previousValue) / Math.abs(previousValue)) * 1000) / 10;
}

function buildReportData(orderRows, purchaseRows) {
  const completedStatuses = new Set(['Completado', 'Entregado']);
  const completedOrders = orderRows.filter((order) => completedStatuses.has(order.status));
  const customers = new Set();
  const salesByDate = {};
  const salesByCategory = {};
  const salesByPayment = {};
  const ordersByStatus = {};
  const salesByProduct = {};
  const topCustomers = {};

  for (const order of orderRows) {
    const status = order.status || 'Sin estado';
    ordersByStatus[status] = (ordersByStatus[status] || 0) + 1;
  }

  for (const order of completedOrders) {
    const total = Number(order.total || 0);
    const name = String(order.customer_name || 'Cliente sin nombre').trim();
    const phone = String(order.customer_phone || '').trim();
    const clientKey = `${name.toLowerCase()}-${phone}`;
    const reportDate = order.report_date;
    customers.add(clientKey);
    salesByDate[reportDate] = (salesByDate[reportDate] || 0) + total;
    salesByPayment[order.payment_method || 'Otro'] = (salesByPayment[order.payment_method || 'Otro'] || 0) + total;

    if (!topCustomers[clientKey]) {
      topCustomers[clientKey] = { name, phone, total: 0, count: 0, products: {}, orderHistory: [] };
    }
    const customer = topCustomers[clientKey];
    customer.total += total;
    customer.count += 1;
    customer.orderHistory.push({ date: order.created_at, total, cart: Array.isArray(order.cart_json) ? order.cart_json : [] });

    const cart = Array.isArray(order.cart_json) ? order.cart_json : [];
    for (const item of cart) {
      const productName = String(item.title || 'Producto');
      const category = String(item.category || 'Otros');
      const quantity = Math.max(0, Number(item.qty || item.quantity || 1));
      const itemTotal = Math.max(0, Number(item.price || 0) * quantity);
      salesByCategory[category] = (salesByCategory[category] || 0) + itemTotal;
      if (!salesByProduct[productName]) salesByProduct[productName] = { name: productName, category, quantity: 0, total: 0 };
      salesByProduct[productName].quantity += quantity;
      salesByProduct[productName].total += itemTotal;
      customer.products[productName] = (customer.products[productName] || 0) + quantity;
    }
  }

  const totalSales = completedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const totalPurchases = purchaseRows.reduce((sum, purchase) => sum + Number(purchase.total_amount || 0), 0);
  const externalOrders = completedOrders.filter((order) => String(order.delivery_provider_type || '').startsWith('external_'));
  const externalDeliveryCost = externalOrders.reduce((sum, order) => sum + Number(order.external_delivery_cost || 0), 0);
  const externalDeliveryRevenue = externalOrders.reduce((sum, order) => sum + Number(order.delivery_fee || 0), 0);
  const grossProfit = totalSales - totalPurchases - externalDeliveryCost;
  const cancelled = orderRows.filter((order) => order.status === 'Cancelado').length;
  const topProducts = Object.values(salesByProduct).sort((a, b) => b.total - a.total).slice(0, 10);
  const clientList = Object.values(topCustomers).map((customer) => {
    const favoriteProduct = Object.entries(customer.products).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Ninguno';
    return { ...customer, favoriteProduct };
  }).sort((a, b) => b.total - a.total).slice(0, 10);

  return {
    kpis: {
      totalVentas: Math.round(totalSales),
      pedidosRealizados: orderRows.length,
      pedidosCompletados: completedOrders.length,
      pedidosCancelados: cancelled,
      clientesAtendidos: customers.size,
      ticketPromedio: completedOrders.length ? Math.round(totalSales / completedOrders.length) : 0,
      utilidadBruta: Math.round(grossProfit),
      totalCompras: Math.round(totalPurchases),
      domiciliosExternos: externalOrders.length,
      costoDomiciliosExternos: Math.round(externalDeliveryCost),
      ingresoDomiciliosExternos: Math.round(externalDeliveryRevenue),
      margenLogisticoExterno: Math.round(externalDeliveryRevenue - externalDeliveryCost),
      margenUtilidad: totalSales ? Math.round((grossProfit / totalSales) * 1000) / 10 : 0,
      tasaFinalizacion: orderRows.length ? Math.round((completedOrders.length / orderRows.length) * 1000) / 10 : 0,
    },
    charts: {
      ventas: Object.entries(salesByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, ventas]) => ({ date, ventas: Math.round(ventas) })),
      categorias: Object.entries(salesByCategory).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value: Math.round(value) })),
      pagos: Object.entries(salesByPayment).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value: Math.round(value) })),
      estados: Object.entries(ordersByStatus).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    },
    lists: { productos: topProducts, clientes: clientList },
  };
}

app.get('/api/pedidos/admin/reports', authenticateToken, async (req, res) => {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const from = String(req.query.from || shiftIsoDate(today, -29));
    const to = String(req.query.to || today);
    if (!validIsoDate(from) || !validIsoDate(to) || from > to) {
      return res.status(400).json({ status: 'error', error: 'El rango de fechas no es válido' });
    }
    const days = Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000) + 1;
    if (days > 366) return res.status(400).json({ status: 'error', error: 'El reporte admite un máximo de 366 días' });
    const previousTo = shiftIsoDate(from, -1);
    const previousFrom = shiftIsoDate(previousTo, -(days - 1));
    const orderSql = `
      SELECT id, customer_name, customer_phone, payment_method, total, cart_json, status,
             delivery_fee, delivery_provider_type, external_delivery_cost,
             created_at, TO_CHAR(created_at, 'YYYY-MM-DD') AS report_date
      FROM pedidos_app_orders
      WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
      ORDER BY created_at ASC`;
    const purchaseSql = `
      SELECT total_amount FROM pedidos_app_purchases
      WHERE purchase_date BETWEEN $1::date AND $2::date`;

    const [ordersResult, purchasesResult, previousOrdersResult, previousPurchasesResult, inventoryResult] = await Promise.all([
      pool.query(orderSql, [from, to]),
      pool.query(purchaseSql, [from, to]),
      pool.query(orderSql, [previousFrom, previousTo]),
      pool.query(purchaseSql, [previousFrom, previousTo]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE track_stock = TRUE AND COALESCE(stock, 0) <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (WHERE track_stock = TRUE AND COALESCE(stock, 0) > 0 AND stock <= COALESCE(low_stock_threshold, 5))::int AS low_stock
        FROM pedidos_app_products WHERE status = 'Activo'`),
    ]);

    const current = buildReportData(ordersResult.rows, purchasesResult.rows);
    const previous = buildReportData(previousOrdersResult.rows, previousPurchasesResult.rows);
    const trendKeys = ['totalVentas', 'pedidosRealizados', 'clientesAtendidos', 'ticketPromedio', 'utilidadBruta'];
    const trends = Object.fromEntries(trendKeys.map((key) => [key, reportPercentageChange(current.kpis[key], previous.kpis[key])]));

    res.json({
      status: 'ok',
      ...current,
      trends,
      alerts: inventoryResult.rows[0] || { out_of_stock: 0, low_stock: 0 },
      meta: { from, to, previousFrom, previousTo, days, timezone: 'America/Bogota' },
    });
  } catch (error) {
    console.error('Error generating reports:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= GASTOS =================
app.get('/api/pedidos/admin/expenses', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_expenses ORDER BY expense_date DESC, id DESC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/expenses', authenticateToken, async (req, res) => {
  try {
    const { category, description, amount, expense_date } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_expenses (category, description, amount, expense_date) 
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE)) RETURNING *`,
      [category, description, amount, expense_date || null]
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pedidos/admin/expenses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_expenses WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= CIERRES CONTABLES =================
function validateClosurePeriod(startDate, endDate) {
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) return 'Las fechas del cierre no son válidas';
  if (startDate > endDate) return 'La fecha inicial debe ser anterior o igual a la final';
  const days = Math.round((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86400000);
  if (days > 366) return 'Un cierre no puede abarcar más de 366 días';
  return '';
}

async function buildClosurePreview(startDate, endDate, db = pool) {
  const [ordersRes, cancelledRes, expensesRes, invRes] = await Promise.all([
    db.query(`SELECT id, total, payment_method, cart_json, delivery_provider_type, external_delivery_cost FROM pedidos_app_orders
      WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN $1 AND $2
        AND status IN ('Entregado', 'Completado')`, [startDate, endDate]),
    db.query(`SELECT COUNT(*)::int AS count FROM pedidos_app_orders
      WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN $1 AND $2 AND status = 'Cancelado'`, [startDate, endDate]),
    db.query('SELECT category, amount FROM pedidos_app_expenses WHERE expense_date BETWEEN $1 AND $2', [startDate, endDate]),
    db.query(`SELECT title AS product_name, inventory_unit AS unit, COALESCE(stock, 0) AS quantity,
      COALESCE(stock, 0) * COALESCE(inventory_unit_cost, 0) AS value
      FROM pedidos_app_products WHERE track_stock = TRUE ORDER BY title`),
  ]);
  const metodosPago = {};
  const productosVendidos = {};
  const categoriasVentas = {};
  let totalVentas = 0;
  for (const order of ordersRes.rows) {
    const total = Number(order.total || 0);
    totalVentas += total;
    const method = String(order.payment_method || 'Efectivo').trim();
    metodosPago[method] = (metodosPago[method] || 0) + total;
    const cart = Array.isArray(order.cart_json) ? order.cart_json : [];
    for (const item of cart) {
      const id = String(item.id || item.product_id || item.productId || '');
      const quantity = Math.max(0, Number(item.quantity || item.qty || 1));
      if (id) productosVendidos[id] = (productosVendidos[id] || 0) + quantity;
      const category = String(item.category || 'General');
      categoriasVentas[category] = (categoriasVentas[category] || 0) + Number(item.price || 0) * quantity;
    }
  }
  const productIds = Object.keys(productosVendidos);
  const productCosts = productIds.length
    ? await db.query('SELECT id, title, inventory_unit_cost FROM pedidos_app_products WHERE id::text = ANY($1::text[])', [productIds])
    : { rows: [] };
  let totalCostoProduccion = 0;
  const desgloseCostos = {};
  for (const product of productCosts.rows) {
    const cost = Number(product.inventory_unit_cost || 0) * Number(productosVendidos[product.id] || 0);
    totalCostoProduccion += cost;
    if (cost) desgloseCostos[product.title] = cost;
  }
  let totalGastos = 0;
  const desgloseGastos = {};
  for (const expense of expensesRes.rows) {
    const amount = Number(expense.amount || 0);
    totalGastos += amount;
    const category = expense.category || 'Otros';
    desgloseGastos[category] = (desgloseGastos[category] || 0) + amount;
  }
  const costoDomiciliosExternos = ordersRes.rows.reduce((sum, order) =>
    sum + (String(order.delivery_provider_type || '').startsWith('external_') ? Number(order.external_delivery_cost || 0) : 0), 0);
  if (costoDomiciliosExternos > 0) {
    totalGastos += costoDomiciliosExternos;
    desgloseGastos['Operadores logísticos externos'] = costoDomiciliosExternos;
  }
  const inventarioSnapshot = invRes.rows.map((row) => ({ name: row.product_name, unit: row.unit,
    quantity: Number(row.quantity), value: Number(row.value) }));
  const efectivoEsperado = Object.entries(metodosPago).reduce((sum, [method, value]) =>
    sum + (/efectivo/i.test(method) ? Number(value) : 0), 0);
  return {
    totalVentas, totalPedidos: ordersRes.rows.length, pedidosCancelados: cancelledRes.rows[0].count,
    totalCostoProduccion, totalGastos, costoDomiciliosExternos,
    utilidadNeta: totalVentas - totalCostoProduccion - totalGastos,
    margenBruto: totalVentas ? ((totalVentas - totalCostoProduccion) / totalVentas) * 100 : 0,
    efectivoEsperado, metodosPago, categoriasVentas, desgloseCostos, desgloseGastos, inventarioSnapshot,
  };
}

app.get('/api/pedidos/admin/closures/preview', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  const invalid = validateClosurePeriod(startDate, endDate);
  if (invalid) return res.status(400).json({ error: invalid });
  try { res.json({ status: 'ok', data: await buildClosurePreview(startDate, endDate) }); }
  catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/admin/closures', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.body;
  const invalid = validateClosurePeriod(startDate, endDate);
  if (invalid) return res.status(400).json({ error: invalid });
  const notes = String(req.body.notes || '').trim().slice(0, 2000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('distrito-accounting-closure'))");
    const overlap = await client.query(`SELECT id FROM pedidos_app_closures
      WHERE status='Cerrado' AND NOT (end_date < $1 OR start_date > $2) LIMIT 1`, [startDate, endDate]);
    if (overlap.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `El período se cruza con el cierre #${overlap.rows[0].id}` });
    }
    const summary = await buildClosurePreview(startDate, endDate, client);
    const cashCounted = req.body.cashCounted === '' || req.body.cashCounted == null
      ? summary.efectivoEsperado : Math.round(Number(req.body.cashCounted));
    if (!Number.isFinite(cashCounted) || cashCounted < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El efectivo contado no es válido' });
    }
    summary.efectivoContado = cashCounted;
    summary.diferenciaEfectivo = cashCounted - summary.efectivoEsperado;
    const { rows } = await client.query(`INSERT INTO pedidos_app_closures
      (start_date, end_date, total_sales, total_costs, total_expenses, net_profit,
       summary_json, closed_by, orders_count, cancelled_orders, cash_expected,
       cash_counted, cash_difference, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [startDate, endDate, summary.totalVentas, summary.totalCostoProduccion, summary.totalGastos,
      summary.utilidadNeta, JSON.stringify(summary), req.user?.username || req.body.closedBy || 'Administrador',
      summary.totalPedidos, summary.pedidosCancelados, summary.efectivoEsperado, cashCounted,
      summary.diferenciaEfectivo, notes]);
    await client.query('COMMIT');
    res.status(201).json({ status: 'ok', data: rows[0] });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.get('/api/pedidos/admin/closures', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_closures ORDER BY id DESC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pedidos/admin/closures/:id/reopen', authenticateToken, async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Indica el motivo de reapertura (mínimo 5 caracteres)' });
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`UPDATE pedidos_app_closures SET status='Abierto', reopened_at=NOW(),
      reopened_by=$2, reopen_reason=$3 WHERE id=$1 AND status='Cerrado' RETURNING *`,
    [id, req.user?.username || 'Administrador', reason.slice(0, 1000)]);
    if (!rows.length) return res.status(404).json({ error: 'Cierre no encontrado o ya está abierto' });
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= PERFIL =================
app.get('/api/pedidos/admin/profile', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.email, u.phone, u.photo_url, u.branch, u.created_at, u.last_access, r.name as role_name
      FROM pedidos_app_users u
      LEFT JOIN pedidos_app_roles r ON u.role_id = r.id
      WHERE u.id = $1
    `, [req.user.id]);
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pedidos/admin/profile/password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `La nueva contraseña debe tener mínimo ${MIN_PASSWORD_LENGTH} caracteres` });
    const { rows } = await pool.query("SELECT password_hash FROM pedidos_app_users WHERE id = $1", [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE pedidos_app_users SET password_hash = $1, must_change_password = FALSE WHERE id = $2", [newHash, req.user.id]);
    await pool.query("INSERT INTO pedidos_app_audit_logs (user_id, action) VALUES ($1, 'Cambio de Contraseña')", [req.user.id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= AUDITORÍA Y SESIONES =================
app.get('/api/pedidos/admin/audit', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, u.username
      FROM pedidos_app_audit_logs a
      LEFT JOIN pedidos_app_users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 200
    `);
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/sessions', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, u.username, r.name as role_name
      FROM pedidos_app_sessions s
      LEFT JOIN pedidos_app_users u ON s.user_id = u.id
      LEFT JOIN pedidos_app_roles r ON u.role_id = r.id
      ORDER BY 
        CASE WHEN s.status = 'Activa' THEN 1 ELSE 2 END,
        s.last_active DESC 
      LIMIT 100
    `);
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/profile/sessions', authenticateToken, async (req, res) => {
  try {
    await expireInactiveSessions(pool, req.user.id);
    const { rows } = await pool.query(`
      SELECT id, device_name, browser, os, ip, location, status, created_at, last_active,
             expires_at, token_jti = $2 AS is_current
      FROM pedidos_app_sessions
      WHERE user_id = $1
      ORDER BY (status = 'Activa') DESC, last_active DESC
      LIMIT 20
    `, [req.user.id, req.user.jti]);
    res.json({ status: 'ok', data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/pedidos/admin/profile/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE pedidos_app_sessions
      SET status = 'Cerrada desde perfil', revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'Activa'
      RETURNING token_jti = $3 AS was_current
    `, [req.params.id, req.user.id, req.user.jti]);
    if (!rows.length) return res.status(404).json({ error: 'Sesión activa no encontrada' });
    await logActivity(req.user.id, 'Perfil', 'Cerrar sesión', `Sesión ID: ${req.params.id}`, req.ip, '', '', {});
    res.json({ status: 'ok', was_current: rows[0].was_current });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/pedidos/admin/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE pedidos_app_sessions SET status = 'Cerrada por administrador' WHERE id = $1", [id]);
    await pool.query("INSERT INTO pedidos_app_audit_logs (user_id, action, details) VALUES ($1, 'Forzar Cierre de Sesión', $2)", [req.user.id, `Sesión ID: ${id}`]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pedidos/admin/profile/info', authenticateToken, async (req, res) => {
  try {
    const { email, phone, photo_url } = req.body;
    await pool.query(
      "UPDATE pedidos_app_users SET email = $1, phone = $2, photo_url = $3 WHERE id = $4",
      [email, phone, photo_url, req.user.id]
    );
    res.json({ status: 'ok', message: 'Perfil actualizado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================= SEGURIDAD Y USUARIOS =================
async function syncDeliveryCapacity(client, userId, roleId, requestedCapacity) {
  const { rows } = await client.query('SELECT name FROM pedidos_app_roles WHERE id = $1', [roleId]);
  if (!rows.length) {
    const error = new Error('El rol seleccionado no existe');
    error.statusCode = 400;
    throw error;
  }
  if (!DELIVERY_ROLES.has(rows[0].name)) return null;
  if (requestedCapacity !== undefined && requestedCapacity !== null && requestedCapacity !== '') {
    const parsed = Number(requestedCapacity);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
      const error = new Error('La capacidad del domiciliario debe estar entre 1 y 5 pedidos');
      error.statusCode = 400;
      throw error;
    }
  }
  const defaults = await client.query('SELECT default_max_driver_capacity FROM pedidos_app_settings WHERE id=1');
  const defaultCapacity = normalizeMaxActiveOrders(defaults.rows[0]?.default_max_driver_capacity, DEFAULT_MAX_ACTIVE_ORDERS);
  const capacity = normalizeMaxActiveOrders(requestedCapacity, defaultCapacity);
  await client.query(`
    INSERT INTO pedidos_app_delivery_profiles (user_id, max_active_orders)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE
    SET max_active_orders = EXCLUDED.max_active_orders, updated_at = NOW()
  `, [userId, capacity]);
  return capacity;
}

app.get('/api/pedidos/admin/users', authenticateToken, requirePermission('Usuarios', 'ver'), async (req, res) => {
  try {
    await expireInactiveSessions(pool);
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.name, u.last_name, u.document, u.email, u.phone,
             u.status, u.role, u.role_id, u.must_change_password, u.last_access,
             u.max_active_sessions, u.session_idle_minutes, r.name AS role_name,
             COALESCE(profile.max_active_orders, $1)::int AS max_active_orders,
             (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
              WHERE active_order.delivery_user_id = u.id
                AND active_order.delivery_status = ANY($2::text[])) AS active_delivery_orders,
             COUNT(s.id) FILTER (WHERE s.status = 'Activa')::int AS active_sessions
      FROM pedidos_app_users u
      LEFT JOIN pedidos_app_roles r ON u.role_id = r.id
      LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
      LEFT JOIN pedidos_app_sessions s ON s.user_id = u.id
      GROUP BY u.id, r.name, profile.max_active_orders
      ORDER BY COALESCE(u.name, u.username), u.username
    `, [DEFAULT_MAX_ACTIVE_ORDERS, COMMITTED_DELIVERY_STATUSES]);
    res.json({ status: 'ok', data: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/admin/users', authenticateToken, requirePermission('Usuarios', 'crear'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, password, email, phone, role_id, name, last_name, document, status, max_active_orders } = req.body;
    if (!username?.trim() || !password || !role_id) return res.status(400).json({ error: 'Usuario, contraseña y rol son obligatorios' });
    if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `La contraseña temporal debe tener mínimo ${MIN_PASSWORD_LENGTH} caracteres` });
    const hash = await bcrypt.hash(password, 10);
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO pedidos_app_users
        (username, password_hash, email, phone, role_id, name, last_name, document, status, must_change_password)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      RETURNING id, username
    `, [username.trim(), hash, email || null, phone || null, role_id, name || null, last_name || null, document || null, status || 'Activo']);
    const deliveryCapacity = await syncDeliveryCapacity(client, rows[0].id, role_id, max_active_orders);
    await client.query('COMMIT');
    const { password: _password, ...auditData } = req.body;
    await logActivity(req.user.id, 'Usuarios', 'Crear', `Usuario creado: ${username}`, req.ip, '', '', auditData);
    res.json({ status: 'ok', data: { ...rows[0], max_active_orders: deliveryCapacity } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'El usuario, correo o documento ya está registrado' });
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally { client.release(); }
});

app.put('/api/pedidos/admin/users/:id', authenticateToken, requirePermission('Usuarios', 'editar'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { username, email, phone, role_id, name, last_name, document, status, password, must_change_password, max_active_orders } = req.body;
    if (!username?.trim() || !role_id) return res.status(400).json({ error: 'Usuario y rol son obligatorios' });
    if (password && password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `La contraseña debe tener mínimo ${MIN_PASSWORD_LENGTH} caracteres` });
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    await client.query('BEGIN');
    const updated = await client.query(`
      UPDATE pedidos_app_users
      SET username=$1, email=$2, phone=$3, role_id=$4, name=$5, last_name=$6,
          document=$7, status=$8,
          password_hash=COALESCE($9, password_hash),
          must_change_password=CASE WHEN $9 IS NOT NULL THEN TRUE ELSE COALESCE($10, must_change_password) END
      WHERE id=$11
      RETURNING id
    `, [username.trim(), email || null, phone || null, role_id, name || null, last_name || null,
      document || null, status || 'Activo', passwordHash, must_change_password, id]);
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const deliveryCapacity = await syncDeliveryCapacity(client, id, role_id, max_active_orders);
    if (status && status !== 'Activo') {
      await client.query("UPDATE pedidos_app_sessions SET status='Cerrada por desactivación', revoked_at=NOW() WHERE user_id=$1 AND status='Activa'", [id]);
    }
    if (deliveryCapacity !== null) {
      await deliveryOrderService.appendDomainEvent(client, 'driver_capacity_updated', 'driver', id, {
        driverId: Number(id), userId: Number(id), capacity: deliveryCapacity,
      });
    }
    await client.query('COMMIT');
    const { password: _password, ...auditData } = req.body;
    await logActivity(req.user.id, 'Usuarios', 'Editar', `Usuario editado ID: ${id}`, req.ip, '', '', auditData);
    res.json({ status: 'ok', max_active_orders: deliveryCapacity });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'El usuario, correo o documento ya está registrado' });
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally { client.release(); }
});

app.delete('/api/pedidos/admin/users/:id', authenticateToken, requirePermission('Usuarios', 'eliminar'), async (req, res) => {
  try {
    if (Number(req.params.id) === Number(req.user.id)) return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    const { rows } = await pool.query(`
      UPDATE pedidos_app_users SET status='Inactivo' WHERE id=$1 RETURNING id
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    await pool.query("UPDATE pedidos_app_sessions SET status='Cerrada por desactivación', revoked_at=NOW() WHERE user_id=$1 AND status='Activa'", [req.params.id]);
    await logActivity(req.user.id, 'Usuarios', 'Desactivar', `Usuario ID: ${req.params.id}`, req.ip, '', '', {});
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pedidos/admin/roles', authenticateToken, requirePermission('Roles', 'ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, COUNT(u.id)::int AS users_count
      FROM pedidos_app_roles r
      LEFT JOIN pedidos_app_users u ON u.role_id = r.id AND u.status = 'Activo'
      GROUP BY r.id ORDER BY r.is_system_role DESC, r.name
    `);
    res.json({ status: 'ok', data: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pedidos/admin/roles-meta', authenticateToken, requirePermission('Roles', 'ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, module, action, description
      FROM pedidos_app_permissions
      WHERE module NOT IN ('Recetas', 'Rendimientos')
      ORDER BY module, action
    `);
    res.json({ status: 'ok', data: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/admin/roles', authenticateToken, requirePermission('Roles', 'crear'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre del rol es obligatorio' });
    const { rows } = await pool.query('INSERT INTO pedidos_app_roles (name, description) VALUES ($1, $2) RETURNING *', [name, description]);
    await logActivity(req.user.id, 'Roles', 'Crear', `Rol creado: ${name}`, req.ip, '', '', req.body);
    res.json({ status: 'ok', data: rows[0] });
  } catch (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Ya existe un rol con ese nombre' : error.message }); }
});

app.put('/api/pedidos/admin/roles/:id', authenticateToken, requirePermission('Roles', 'editar'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const { rows: current } = await pool.query('SELECT is_system_role, name FROM pedidos_app_roles WHERE id=$1', [id]);
    if (!current.length) return res.status(404).json({ error: 'Rol no encontrado' });
    const safeName = current[0].is_system_role ? current[0].name : name;
    await pool.query('UPDATE pedidos_app_roles SET name=$1, description=$2 WHERE id=$3', [safeName, description, id]);
    await logActivity(req.user.id, 'Roles', 'Editar', `Rol editado ID: ${id}`, req.ip, '', '', req.body);
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/pedidos/admin/roles/:id', authenticateToken, requirePermission('Roles', 'eliminar'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.is_system_role, COUNT(u.id)::int AS users_count
      FROM pedidos_app_roles r LEFT JOIN pedidos_app_users u ON u.role_id=r.id
      WHERE r.id=$1 GROUP BY r.id
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Rol no encontrado' });
    if (rows[0].is_system_role || rows[0].users_count > 0) return res.status(409).json({ error: 'No se puede eliminar un rol del sistema o asignado a usuarios' });
    await pool.query('DELETE FROM pedidos_app_roles WHERE id=$1', [req.params.id]);
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pedidos/admin/roles/:id/permissions', authenticateToken, requirePermission('Roles', 'ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.module || ':' || p.action AS permission
      FROM pedidos_app_role_permissions rp
      JOIN pedidos_app_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.module, p.action
    `, [req.params.id]);
    res.json({ status: 'ok', data: rows.map(r => r.permission) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/admin/roles/:id/permissions', authenticateToken, requirePermission('Roles', 'editar'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) return res.status(400).json({ error: 'Permisos inválidos' });
    const uniquePermissions = [...new Set(permissions.map(String))];
    const { rows } = await client.query(`
      SELECT id, module || ':' || action AS permission
      FROM pedidos_app_permissions
      WHERE module || ':' || action = ANY($1::text[])
    `, [uniquePermissions]);
    if (rows.length !== uniquePermissions.length) {
      return res.status(400).json({ error: 'La selección contiene permisos desconocidos' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM pedidos_app_role_permissions WHERE role_id=$1', [req.params.id]);
    for (const permission of rows) {
      await client.query(
        'INSERT INTO pedidos_app_role_permissions (role_id, permission_id) VALUES ($1, $2)',
        [req.params.id, permission.id]
      );
    }
    await client.query('COMMIT');
    res.json({ status: 'ok' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/pedidos/admin/permissions', authenticateToken, requirePermission('Permisos', 'ver'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_permissions');
    res.json({ status: 'ok', data: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pedidos/admin/permissions', authenticateToken, requirePermission('Permisos', 'crear'), async (req, res) => {
  try {
    const { module, action, description } = req.body;
    const { rows } = await pool.query('INSERT INTO pedidos_app_permissions (module, action, description) VALUES ($1, $2, $3) RETURNING *', [module, action, description]);
    res.json({ status: 'ok', data: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pedidos/admin/permissions/:id', authenticateToken, requirePermission('Permisos', 'editar'), async (req, res) => {
  try {
    const { module, action, description } = req.body;
    await pool.query('UPDATE pedidos_app_permissions SET module=$1, action=$2, description=$3 WHERE id=$4', [module, action, description, req.params.id]);
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/pedidos/admin/permissions/:id', authenticateToken, requirePermission('Permisos', 'eliminar'), async (req, res) => {
  try {
    await pool.query('DELETE FROM pedidos_app_permissions WHERE id=$1', [req.params.id]);
    res.json({ status: 'ok' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3001;
const horariosApi = require('./horarios_api')(app, pool, authenticateToken);
getHorariosStatus = horariosApi.getHorariosStatus;

deliveryRealtime = require('./delivery_api')(app, {
  pool,
  authenticateToken,
  requirePermission,
  trackingLimiter,
  minPasswordLength: MIN_PASSWORD_LENGTH,
  webpush,
  publicVapidKey,
  authorizeTrackingAccess,
  trackingSecret: JWT_SECRET,
  deliveryOrderService,
  publishEphemeral: async (eventName, payload) => {
    const eventId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO pedidos_app_domain_events
        (event_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES ($1,'realtime',$2,$3,$4::jsonb)
    `, [eventId, String(payload.deliveryUserId || payload.orderId || 'global'), eventName,
      JSON.stringify({ ...payload, eventId })]);
  },
});
require('./external_delivery_api')(app, {
  pool,
  authenticateToken,
  requirePermission,
});
require('./crm_api')(app, {
  pool,
  authenticateToken,
  requirePermission,
  whatsappClient,
});

const deliveryOutbox = createOutboxDispatcher({
  pool,
  onEvent: async (event) => {
    await crmWorker.handleDomainEvent(event);
    const payload = {
      ...(event.payload || {}),
      eventId: event.event_id,
      occurredAt: event.occurred_at,
    };
    if (event.event_type === 'session_revoked') {
      deliveryRealtime.publish('session_revoked', payload, (connectedClient) => (
        Number(connectedClient.userId) === Number(payload.userId)
      ));
    } else if (event.aggregate_type === 'realtime' && event.event_type === 'delivery_location') {
      deliveryRealtime.publish('delivery_location', payload, (connectedClient) => {
        const orderIds = Array.isArray(payload.orderIds) ? payload.orderIds.map(Number) : [Number(payload.orderId)];
        if (connectedClient.kind === 'tracking') return orderIds.includes(Number(connectedClient.orderId));
        if (DELIVERY_ROLES.has(connectedClient.role)) return Number(connectedClient.userId) === Number(payload.deliveryUserId);
        return true;
      });
    } else if (event.aggregate_type === 'order') {
      deliveryRealtime.publish(event.event_type, payload);
      if (event.event_type === 'order_reserved') deliveryRealtime.publish('order_available', payload);
      if (event.event_type === 'order_accepted') deliveryRealtime.publish('order_assigned', payload);
      deliveryRealtime.publish('order_updated', payload);
    } else if (event.aggregate_type === 'driver') {
      deliveryRealtime.publish(event.event_type, payload);
      deliveryRealtime.publish('driver_presence', payload);
    } else {
      deliveryRealtime.publish(event.event_type, payload);
    }
  },
});
deliveryOutbox.start()
  .then(() => { outboxReady = true; })
  .catch((error) => {
    outboxReady = false;
    console.error(JSON.stringify({ level: 'error', component: 'outbox-start', message: error.message }));
  });
crmWorker.start()
  .then(() => { crmWorkerReady = true; })
  .catch((error) => {
    crmWorkerReady = false;
    console.error(JSON.stringify({ level: 'error', component: 'crm-worker-start', message: error.message }));
  });

app.use('/api/pedidos', (req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada' });
});

app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/pedidos')) return next(error);
  console.error('Error HTTP no controlado:', error.message);
  return res.status(error.statusCode || 500).json({ error: 'No fue posible procesar la solicitud' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
