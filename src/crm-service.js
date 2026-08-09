const crypto = require('node:crypto');
const { normalizePhoneE164 } = require('./crm/phone');
const { compileSegment } = require('./crm/segments');

const MESSAGE_STATUS = Object.freeze({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' });
const MESSAGE_RANK = Object.freeze({ RECEIVED: 0, QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5, CANCELLED: 5 });

function crmError(code, message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function safeText(value, maximum = 4096) {
  return String(value || '').trim().slice(0, maximum);
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

function extractMessageText(message) {
  if (message.type === 'text') return safeText(message.text?.body);
  if (message.type === 'button') return safeText(message.button?.text || message.button?.payload);
  if (message.type === 'interactive') {
    return safeText(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title);
  }
  if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
    return safeText(message[message.type]?.caption || `[${message.type}]`);
  }
  if (message.type === 'location') return safeText(message.location?.name || message.location?.address || '[ubicación]');
  return `[${safeText(message.type || 'mensaje', 30)}]`;
}

function publicMessageContent(message) {
  const type = safeText(message.type || 'unknown', 20);
  const source = message[type] || {};
  if (type === 'location') {
    return { latitude: source.latitude, longitude: source.longitude, name: safeText(source.name, 200), address: safeText(source.address, 300) };
  }
  if (['image', 'audio', 'video', 'document'].includes(type)) {
    return { mediaId: safeText(source.id, 180), mimeType: safeText(source.mime_type, 120), filename: safeText(source.filename, 240), caption: safeText(source.caption, 1000), sha256: safeText(source.sha256, 128) };
  }
  if (type === 'interactive') return { interactive: source };
  return {};
}

function buildCampaignTemplateComponents(configuration = {}, renderedValues = {}) {
  const allowedSources = new Set([
    'contact.name','contact.phone','contact.barrio','contact.orders_count','contact.total_spent',
  ]);
  const components = [];
  for (const type of ['header','body']) {
    const sources = Array.isArray(configuration[type]) ? configuration[type] : [];
    if (!sources.length) continue;
    const parameters = sources.map((source) => {
      const normalized = String(source || '');
      if (!allowedSources.has(normalized)) throw crmError('WHATSAPP_TEMPLATE_INVALID', `Variable no permitida: ${normalized || '(vacía)'}.`, 400);
      return { type: 'text', text: String(renderedValues[normalized] ?? '').slice(0, 1024) };
    });
    components.push({ type, parameters });
  }
  return components;
}

async function appendCrmEvent(client, eventType, aggregateType, aggregateId, payload = {}) {
  const eventId = crypto.randomUUID();
  await client.query(`
    INSERT INTO pedidos_app_domain_events (event_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES ($1,$2,$3,$4,$5::jsonb)
  `, [eventId, aggregateType, String(aggregateId), eventType, JSON.stringify({ ...payload, eventId })]);
  return eventId;
}

async function scheduleEventAutomations(client, triggerType, contactId, entityType, entityId) {
  if (!contactId) return 0;
  const { rowCount } = await client.query(`
    INSERT INTO pedidos_app_crm_automation_runs
      (automation_id,contact_id,trigger_entity_type,trigger_entity_id,run_key,status,scheduled_at)
    SELECT automation.id,$2::bigint,$3::varchar,$4::varchar,
      'event:' || automation.id::text || ':' || $3::text || ':' || $4::text || ':' || $2::text,
      'SCHEDULED',NOW()+(automation.wait_minutes*INTERVAL '1 minute')
    FROM pedidos_app_crm_automations automation
    WHERE automation.is_active AND automation.trigger_type=$1
    ON CONFLICT (run_key) DO NOTHING
  `, [triggerType, contactId, entityType, String(entityId)]);
  return rowCount;
}

async function ensureContact(client, { phone, name = null, source = 'WHATSAPP', email = null, address = null, barrio = null }) {
  const normalizedPhone = normalizePhoneE164(phone);
  if (!normalizedPhone) throw crmError('CRM_PHONE_INVALID', 'El teléfono no se puede normalizar a E.164.', 400);
  const { rows } = await client.query(`
    INSERT INTO pedidos_app_crm_contacts
      (normalized_phone,display_name,email,address,barrio,source,first_contact_at,last_contact_at,status)
    VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),'PROSPECTO')
    ON CONFLICT (normalized_phone) DO UPDATE SET
      display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),pedidos_app_crm_contacts.display_name),
      email=COALESCE(NULLIF(EXCLUDED.email,''),pedidos_app_crm_contacts.email),
      address=COALESCE(NULLIF(EXCLUDED.address,''),pedidos_app_crm_contacts.address),
      barrio=COALESCE(NULLIF(EXCLUDED.barrio,''),pedidos_app_crm_contacts.barrio),
      first_contact_at=COALESCE(pedidos_app_crm_contacts.first_contact_at,NOW()),
      last_contact_at=NOW(),updated_at=NOW()
    RETURNING *
  `, [normalizedPhone, safeText(name, 255) || null, safeText(email, 255) || null,
    safeText(address, 1000) || null, safeText(barrio, 255) || null, safeText(source, 40) || 'OTRO']);
  const contact = rows[0];
  await client.query(`
    INSERT INTO pedidos_app_crm_contact_customers (contact_id,customer_id)
    SELECT $1,id FROM pedidos_app_customers WHERE phone_e164=$2
    ON CONFLICT (customer_id) DO UPDATE SET contact_id=EXCLUDED.contact_id
  `, [contact.id, normalizedPhone]);
  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.id]);
  return contact;
}

async function ensureConversation(client, { contactId, providerAccountId = null, assignedUserId = null }) {
  const inserted = await client.query(`
    INSERT INTO pedidos_app_crm_conversations
      (contact_id,channel,provider_account_id,status,assigned_user_id,first_message_at,last_message_at)
    VALUES ($1,'WHATSAPP',$2,'OPEN',$3,NOW(),NOW())
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [contactId, providerAccountId, assignedUserId]);
  if (inserted.rows.length) return inserted.rows[0];
  const existing = await client.query(`
    UPDATE pedidos_app_crm_conversations SET
      provider_account_id=COALESCE($2,provider_account_id),
      assigned_user_id=COALESCE(assigned_user_id,$3),updated_at=NOW()
    WHERE id=(
      SELECT id FROM pedidos_app_crm_conversations
      WHERE contact_id=$1 AND channel='WHATSAPP' AND status IN ('OPEN','PENDING')
      ORDER BY id DESC LIMIT 1 FOR UPDATE
    )
    RETURNING *
  `, [contactId, providerAccountId, assignedUserId]);
  if (!existing.rows.length) throw crmError('CRM_CONVERSATION_CONFLICT', 'No fue posible abrir la conversación de forma segura.', 409);
  return existing.rows[0];
}

async function processInboundMessage(client, value, message, contactProfile) {
  const phone = message.from || contactProfile?.wa_id;
  const contact = await ensureContact(client, { phone, name: contactProfile?.profile?.name, source: 'WHATSAPP' });
  const conversation = await ensureConversation(client, {
    contactId: contact.id,
    providerAccountId: value.metadata?.phone_number_id || null,
  });
  const type = ['text','image','audio','video','document','location','interactive'].includes(message.type) ? message.type : 'unknown';
  const occurredAt = /^\d+$/.test(String(message.timestamp || '')) ? new Date(Number(message.timestamp) * 1000) : new Date();
  const inserted = await client.query(`
    INSERT INTO pedidos_app_crm_messages
      (conversation_id,contact_id,provider_message_id,context_provider_message_id,direction,message_type,
       text_body,content,status,received_at,created_at)
    VALUES ($1,$2,$3,$4,'INBOUND',$5,$6,$7::jsonb,'RECEIVED',$8,$8)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [conversation.id, contact.id, message.id, message.context?.id || null, type,
    extractMessageText(message), JSON.stringify(publicMessageContent(message)), occurredAt]);
  if (!inserted.rowCount) return { duplicate: true, contactId: contact.id, conversationId: conversation.id };

  await client.query(`
    UPDATE pedidos_app_crm_conversations
    SET unread_count=unread_count+1,first_message_at=COALESCE(first_message_at,$2),
        last_message_at=$2,last_inbound_at=$2,status='OPEN',closed_at=NULL,updated_at=NOW()
    WHERE id=$1
  `, [conversation.id, occurredAt]);
  await client.query(`
    UPDATE pedidos_app_crm_contacts SET first_contact_at=COALESCE(first_contact_at,$2),
      last_contact_at=$2,updated_at=NOW() WHERE id=$1
  `, [contact.id, occurredAt]);
  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.id]);
  await client.query(`
    INSERT INTO pedidos_app_crm_activities
      (contact_id,activity_type,entity_type,entity_id,summary,metadata,occurred_at)
    VALUES ($1,'MESSAGE_RECEIVED','CRM_MESSAGE',$2,$3,$4::jsonb,$5)
  `, [contact.id, String(inserted.rows[0].id), `Mensaje ${type} recibido por WhatsApp`,
    JSON.stringify({ conversationId: conversation.id, messageType: type }), occurredAt]);
  await appendCrmEvent(client, 'whatsapp.message.received', 'crm_conversation', conversation.id, {
    contactId: Number(contact.id), conversationId: Number(conversation.id), messageId: Number(inserted.rows[0].id),
  });
  await scheduleEventAutomations(client, 'CONTACT_CREATED', contact.id, 'CRM_CONTACT', contact.id);
  await scheduleEventAutomations(client, 'MESSAGE_RECEIVED', contact.id, 'CRM_MESSAGE', inserted.rows[0].id);
  return { duplicate: false, contactId: contact.id, conversationId: conversation.id, messageId: inserted.rows[0].id };
}

async function processMessageStatus(client, statusEvent) {
  const nextStatus = MESSAGE_STATUS[String(statusEvent.status || '').toLowerCase()];
  if (!nextStatus || !statusEvent.id) return { ignored: true };
  const current = await client.query(`
    SELECT message.id,message.status,message.contact_id,message.conversation_id,recipient.id AS recipient_id,recipient.campaign_id
    FROM pedidos_app_crm_messages message
    LEFT JOIN pedidos_app_crm_campaign_recipients recipient ON recipient.message_id=message.id OR recipient.provider_message_id=message.provider_message_id
    WHERE message.provider_message_id=$1 LIMIT 1
  `, [statusEvent.id]);
  if (!current.rows.length) return { ignored: true };
  const row = current.rows[0];
  const effectiveStatus = MESSAGE_RANK[nextStatus] >= (MESSAGE_RANK[row.status] ?? -1) ? nextStatus : row.status;
  const occurredAt = /^\d+$/.test(String(statusEvent.timestamp || '')) ? new Date(Number(statusEvent.timestamp) * 1000) : new Date();
  const errorItem = statusEvent.errors?.[0] || null;
  await client.query(`
    UPDATE pedidos_app_crm_messages SET status=$2::varchar,
      sent_at=CASE WHEN $2::text IN ('SENT','DELIVERED','READ') THEN COALESCE(sent_at,$3::timestamptz) ELSE sent_at END,
      delivered_at=CASE WHEN $2::text IN ('DELIVERED','READ') THEN COALESCE(delivered_at,$3::timestamptz) ELSE delivered_at END,
      read_at=CASE WHEN $2::text='READ' THEN COALESCE(read_at,$3::timestamptz) ELSE read_at END,
      failed_at=CASE WHEN $2::text='FAILED' THEN COALESCE(failed_at,$3::timestamptz) ELSE failed_at END,
      error_code=CASE WHEN $2::text='FAILED' THEN $4::varchar ELSE error_code END,
      error_message=CASE WHEN $2::text='FAILED' THEN $5::varchar ELSE error_message END
    WHERE id=$1
  `, [row.id, effectiveStatus, occurredAt, errorItem?.code ? String(errorItem.code) : null, safeText(errorItem?.title || errorItem?.message, 500) || null]);
  if (row.recipient_id) {
    await client.query(`
      UPDATE pedidos_app_crm_campaign_recipients SET status=$2::varchar,
        sent_at=CASE WHEN $2::text IN ('SENT','DELIVERED','READ') THEN COALESCE(sent_at,$3::timestamptz) ELSE sent_at END,
        delivered_at=CASE WHEN $2::text IN ('DELIVERED','READ') THEN COALESCE(delivered_at,$3::timestamptz) ELSE delivered_at END,
        read_at=CASE WHEN $2::text='READ' THEN COALESCE(read_at,$3::timestamptz) ELSE read_at END,
        failed_at=CASE WHEN $2::text='FAILED' THEN COALESCE(failed_at,$3::timestamptz) ELSE failed_at END,updated_at=NOW()
      WHERE id=$1 AND status <> 'CONVERTED'
    `, [row.recipient_id, effectiveStatus, occurredAt]);
    await client.query('SELECT pedidos_app_crm_refresh_campaign($1)', [row.campaign_id]);
  }
  await appendCrmEvent(client, 'whatsapp.message.status', 'crm_conversation', row.conversation_id, {
    contactId: Number(row.contact_id), conversationId: Number(row.conversation_id), messageId: Number(row.id), status: effectiveStatus,
  });
  return { ignored: false, messageId: row.id, status: effectiveStatus };
}

function whatsappWebhookEventType(body) {
  let messages = 0;
  let statuses = 0;
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      messages += Array.isArray(change.value?.messages) ? change.value.messages.length : 0;
      statuses += Array.isArray(change.value?.statuses) ? change.value.statuses.length : 0;
    }
  }
  if (messages && statuses) return 'MESSAGES_AND_STATUSES';
  if (messages) return 'MESSAGES';
  if (statuses) return 'MESSAGE_STATUSES';
  return 'WHATSAPP_EVENT';
}

async function registerWhatsAppWebhook(pool, body, rawBody) {
  const eventKey = `whatsapp:${hashPayload(rawBody || body)}`;
  const { rows } = await pool.query(`
    INSERT INTO pedidos_app_crm_webhook_events (event_key,event_type,signature_valid,payload)
    VALUES ($1,$2,TRUE,$3::jsonb)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id,event_key,processing_status
  `, [eventKey, whatsappWebhookEventType(body), JSON.stringify(body)]);
  return { eventKey, duplicate: rows.length === 0, eventId: rows[0]?.id || null };
}

async function processStoredWhatsAppWebhook(pool, eventKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT payload FROM pedidos_app_crm_webhook_events
      WHERE event_key=$1 AND processing_status IN ('RECEIVED','FAILED')
      FOR UPDATE SKIP LOCKED
    `, [eventKey]);
    if (!rows.length) { await client.query('COMMIT'); return { duplicate: true, processed: 0 }; }
    const body = rows[0].payload || {};
    let processed = 0;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const profiles = new Map((value.contacts || []).map((profile) => [profile.wa_id, profile]));
        for (const message of value.messages || []) {
          const result = await processInboundMessage(client, value, message, profiles.get(message.from));
          if (!result.duplicate) processed += 1;
        }
        for (const statusEvent of value.statuses || []) {
          const result = await processMessageStatus(client, statusEvent);
          if (!result.ignored) processed += 1;
        }
      }
    }
    await client.query(`
      UPDATE pedidos_app_crm_webhook_events SET processing_status='PROCESSED',processed_at=NOW() WHERE event_key=$1
    `, [eventKey]);
    await client.query(`
      UPDATE pedidos_app_crm_provider_state SET webhook_connected=TRUE,last_webhook_at=NOW(),updated_at=NOW()
      WHERE provider='WHATSAPP'
    `);
    await client.query('COMMIT');
    return { duplicate: false, processed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`
      UPDATE pedidos_app_crm_webhook_events
      SET processing_status='FAILED',error_code=$2,error_message=$3
      WHERE event_key=$1
    `, [eventKey, safeText(error.code || 'WHATSAPP_WEBHOOK_PROCESSING_FAILED', 80), safeText(error.message, 500)]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processWhatsAppWebhook(pool, body, rawBody) {
  const registration = await registerWhatsAppWebhook(pool, body, rawBody);
  if (registration.duplicate) return { duplicate: true, processed: 0 };
  return processStoredWhatsAppWebhook(pool, registration.eventKey);
}

async function processPendingWhatsAppWebhooks(pool, limit = 10) {
  const { rows } = await pool.query(`
    SELECT event_key FROM pedidos_app_crm_webhook_events
    WHERE provider='WHATSAPP' AND processing_status='RECEIVED'
    ORDER BY received_at,id LIMIT $1
  `, [Math.max(1, Math.min(100, Number(limit) || 10))]);
  let processedEvents = 0;
  for (const row of rows) {
    try {
      const result = await processStoredWhatsAppWebhook(pool, row.event_key);
      if (!result.duplicate) processedEvents += 1;
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error', component: 'whatsapp-webhook-worker', event_key: row.event_key,
        code: error.code || 'WHATSAPP_WEBHOOK_PROCESSING_FAILED', message: error.message,
      }));
    }
  }
  return processedEvents;
}

async function queueConversationMessage(pool, { conversationId, actorUserId, text = null, template = null, idempotencyKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversationResult = await client.query(`
      SELECT conversation.*,contact.normalized_phone,contact.no_contact,contact.marketing_opt_out
      FROM pedidos_app_crm_conversations conversation
      JOIN pedidos_app_crm_contacts contact ON contact.id=conversation.contact_id
      WHERE conversation.id=$1 FOR UPDATE OF conversation
    `, [conversationId]);
    if (!conversationResult.rows.length) throw crmError('CONVERSATION_NOT_FOUND', 'Conversación no encontrada.', 404);
    const conversation = conversationResult.rows[0];
    if (conversation.no_contact || conversation.marketing_opt_out) throw crmError('CONTACT_OPTED_OUT', 'El contacto solicitó no recibir mensajes.', 409);
    let jobType;
    let messageType;
    let payload;
    if (template) {
      const templateResult = await client.query(`SELECT * FROM pedidos_app_crm_whatsapp_templates WHERE id=$1`, [template.id]);
      const templateRow = templateResult.rows[0];
      if (!templateRow || templateRow.status !== 'APPROVED') throw crmError('WHATSAPP_TEMPLATE_INVALID', 'La plantilla debe estar aprobada por Meta.', 409);
      jobType = 'TEMPLATE';
      messageType = 'template';
      payload = { to: conversation.normalized_phone, name: templateRow.name, language: templateRow.language, components: template.components || [] };
    } else {
      const cleanText = safeText(text, 4096);
      if (!cleanText) throw crmError('WHATSAPP_MESSAGE_EMPTY', 'Escribe un mensaje antes de enviarlo.', 400);
      if (!conversation.last_inbound_at || new Date(conversation.last_inbound_at).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
        throw crmError('WHATSAPP_SESSION_EXPIRED', 'La ventana de atención de 24 horas terminó. Usa una plantilla aprobada.', 409);
      }
      jobType = 'TEXT';
      messageType = 'text';
      payload = { to: conversation.normalized_phone, body: cleanText };
    }
    const key = safeText(idempotencyKey, 180) || crypto.randomUUID();
    const existing = await client.query('SELECT message_id FROM pedidos_app_crm_message_jobs WHERE job_key=$1', [`manual:${actorUserId}:${key}`]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { duplicate: true, messageId: existing.rows[0].message_id };
    }
    const messageResult = await client.query(`
      INSERT INTO pedidos_app_crm_messages
        (conversation_id,contact_id,direction,message_type,text_body,content,status,sent_by,queued_at)
      VALUES ($1,$2,'OUTBOUND',$3,$4,$5::jsonb,'QUEUED',$6,NOW()) RETURNING id
    `, [conversation.id, conversation.contact_id, messageType, safeText(text, 4096) || null, JSON.stringify(template || {}), actorUserId]);
    await client.query(`
      INSERT INTO pedidos_app_crm_message_jobs (job_key,message_id,job_type,payload)
      VALUES ($1,$2,$3,$4::jsonb)
    `, [`manual:${actorUserId}:${key}`, messageResult.rows[0].id, jobType, JSON.stringify(payload)]);
    await client.query(`UPDATE pedidos_app_crm_conversations SET last_outbound_at=NOW(),last_message_at=NOW(),updated_at=NOW() WHERE id=$1`, [conversation.id]);
    await client.query(`
      INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,actor_user_id,summary,metadata)
      VALUES ($1,'MESSAGE_QUEUED','CRM_MESSAGE',$2,$3,'Mensaje de WhatsApp en cola',$4::jsonb)
    `, [conversation.contact_id, String(messageResult.rows[0].id), actorUserId, JSON.stringify({ conversationId: conversation.id, type: messageType })]);
    await client.query('COMMIT');
    return { duplicate: false, messageId: messageResult.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function createCrmWorker({ pool, whatsappClient, instanceId = `crm-${process.pid}-${crypto.randomUUID().slice(0, 8)}`, intervalMs = 1000 }) {
  let timer = null;
  let sweepingTimer = null;
  let running = false;
  let stopped = true;
  let lastAutomationSweepAt = 0;

  async function claimJob() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT job.* FROM pedidos_app_crm_message_jobs job
        WHERE job.status IN ('PENDING','RETRY') AND job.available_at<=NOW()
        ORDER BY job.priority DESC,job.available_at,job.id
        FOR UPDATE SKIP LOCKED LIMIT 1
      `);
      if (!rows.length) { await client.query('COMMIT'); return null; }
      await client.query(`
        UPDATE pedidos_app_crm_message_jobs SET status='PROCESSING',attempts=attempts+1,
          locked_at=NOW(),locked_by=$2,updated_at=NOW() WHERE id=$1
      `, [rows[0].id, instanceId]);
      await client.query(`UPDATE pedidos_app_crm_messages SET status='SENDING' WHERE id=$1 AND status='QUEUED'`, [rows[0].message_id]);
      await client.query(`UPDATE pedidos_app_crm_campaign_recipients SET status='SENDING',updated_at=NOW() WHERE id=$1 AND status='QUEUED'`, [rows[0].campaign_recipient_id]);
      await client.query('COMMIT');
      return { ...rows[0], attempts: Number(rows[0].attempts) + 1 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function isCampaignSendAllowed(job) {
    if (!job.campaign_recipient_id) return { allowed: true };
    const { rows } = await pool.query(`
      SELECT recipient.id,recipient.campaign_id,recipient.contact_id,campaign.status,
             contact.marketing_opt_in,contact.marketing_opt_out,contact.no_contact,
             ((NOW() AT TIME ZONE COALESCE(settings.timezone,'America/Bogota'))::time
                BETWEEN settings.crm_campaign_start_time AND settings.crm_campaign_end_time) AS within_hours
      FROM pedidos_app_crm_campaign_recipients recipient
      JOIN pedidos_app_crm_campaigns campaign ON campaign.id=recipient.campaign_id
      JOIN pedidos_app_crm_contacts contact ON contact.id=recipient.contact_id
      CROSS JOIN pedidos_app_settings settings
      WHERE recipient.id=$1 AND settings.id=1
    `, [job.campaign_recipient_id]);
    const row = rows[0];
    if (!row) return { allowed: false, permanent: true, reason: 'RECIPIENT_NOT_FOUND' };
    if (!['RUNNING','SCHEDULED'].includes(row.status)) return { allowed: false, permanent: row.status === 'CANCELLED', reason: 'CAMPAIGN_NOT_RUNNING', campaignId: row.campaign_id };
    if (!row.marketing_opt_in) return { allowed: false, permanent: true, reason: 'MARKETING_CONSENT_REQUIRED', campaignId: row.campaign_id };
    if (row.marketing_opt_out || row.no_contact) return { allowed: false, permanent: true, reason: 'CONTACT_OPTED_OUT', campaignId: row.campaign_id };
    if (!row.within_hours) return { allowed: false, permanent: false, reason: 'OUTSIDE_CAMPAIGN_HOURS', campaignId: row.campaign_id };
    return { allowed: true, campaignId: row.campaign_id };
  }

  async function deferOrCancel(job, gate) {
    if (gate.permanent) {
      await pool.query(`UPDATE pedidos_app_crm_message_jobs SET status='CANCELLED',last_error_code=$2,last_error_message=$3,updated_at=NOW() WHERE id=$1`, [job.id, gate.reason, 'Destinatario excluido en la validación previa al envío']);
      if (job.message_id) await pool.query(`UPDATE pedidos_app_crm_messages SET status='CANCELLED',error_code=$2 WHERE id=$1`, [job.message_id, gate.reason]);
      if (job.campaign_recipient_id) await pool.query(`UPDATE pedidos_app_crm_campaign_recipients SET status='EXCLUDED',exclusion_reason=$2,updated_at=NOW() WHERE id=$1`, [job.campaign_recipient_id, gate.reason]);
    } else {
      await pool.query(`UPDATE pedidos_app_crm_message_jobs SET status='RETRY',available_at=NOW()+INTERVAL '15 minutes',locked_at=NULL,locked_by=NULL,last_error_code=$2,updated_at=NOW() WHERE id=$1`, [job.id, gate.reason]);
      if (job.message_id) await pool.query(`UPDATE pedidos_app_crm_messages SET status='QUEUED' WHERE id=$1`, [job.message_id]);
      if (job.campaign_recipient_id) await pool.query(`UPDATE pedidos_app_crm_campaign_recipients SET status='QUEUED',updated_at=NOW() WHERE id=$1`, [job.campaign_recipient_id]);
    }
    if (gate.campaignId) await pool.query('SELECT pedidos_app_crm_refresh_campaign($1)', [gate.campaignId]);
  }

  async function completeJob(job, response) {
    const providerMessageId = response.messages?.[0]?.id;
    if (!providerMessageId) throw crmError('WHATSAPP_SEND_FAILED', 'Meta no devolvió el identificador del mensaje.', 502);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const message = await client.query(`
        UPDATE pedidos_app_crm_messages SET provider_message_id=$2,status='SENT',sent_at=NOW(),error_code=NULL,error_message=NULL
        WHERE id=$1 RETURNING conversation_id,contact_id
      `, [job.message_id, providerMessageId]);
      await client.query(`
        UPDATE pedidos_app_crm_message_jobs SET status='COMPLETED',completed_at=NOW(),locked_at=NULL,locked_by=NULL,
          last_error_code=NULL,last_error_message=NULL,updated_at=NOW() WHERE id=$1
      `, [job.id]);
      let campaignId = null;
      if (job.campaign_recipient_id) {
        const recipient = await client.query(`
          UPDATE pedidos_app_crm_campaign_recipients SET message_id=$2,provider_message_id=$3,status='SENT',sent_at=NOW(),updated_at=NOW()
          WHERE id=$1 RETURNING campaign_id
        `, [job.campaign_recipient_id, job.message_id, providerMessageId]);
        campaignId = recipient.rows[0]?.campaign_id;
        if (campaignId) await client.query('SELECT pedidos_app_crm_refresh_campaign($1)', [campaignId]);
      }
      await client.query(`UPDATE pedidos_app_crm_provider_state SET configured=TRUE,number_connected=TRUE,last_outbound_at=NOW(),last_error_code=NULL,updated_at=NOW() WHERE provider='WHATSAPP'`);
      if (message.rows.length) {
        await appendCrmEvent(client, 'whatsapp.message.sent', 'crm_conversation', message.rows[0].conversation_id, {
          contactId: Number(message.rows[0].contact_id), conversationId: Number(message.rows[0].conversation_id), messageId: Number(job.message_id), campaignId: campaignId ? Number(campaignId) : null,
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function failJob(job, error) {
    // Si la conexión se cortó después de enviar, Meta podría haber aceptado el mensaje.
    // No reintentamos ese caso automáticamente para no duplicar comunicaciones al cliente.
    const finalFailure = error.code === 'WHATSAPP_DELIVERY_UNCERTAIN'
      || job.attempts >= Number(job.max_attempts || 5);
    const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, job.attempts - 1)));
    const status = finalFailure ? 'FAILED' : 'RETRY';
    await pool.query(`
      UPDATE pedidos_app_crm_message_jobs SET status=$2,available_at=CASE WHEN $2='RETRY' THEN NOW()+($3*INTERVAL '1 second') ELSE available_at END,
        locked_at=NULL,locked_by=NULL,last_error_code=$4,last_error_message=$5,updated_at=NOW() WHERE id=$1
    `, [job.id, status, delaySeconds, safeText(error.code || 'WHATSAPP_SEND_FAILED', 80), safeText(error.message, 500)]);
    if (job.message_id) await pool.query(`
      UPDATE pedidos_app_crm_messages SET status=$2,error_code=$3,error_message=$4,
        failed_at=CASE WHEN $2='FAILED' THEN NOW() ELSE failed_at END WHERE id=$1
    `, [job.message_id, finalFailure ? 'FAILED' : 'QUEUED', safeText(error.code, 80), safeText(error.message, 500)]);
    let campaignId = null;
    if (job.campaign_recipient_id) {
      const recipient = await pool.query(`
        UPDATE pedidos_app_crm_campaign_recipients SET status=$2,failed_at=CASE WHEN $2='FAILED' THEN NOW() ELSE failed_at END,updated_at=NOW()
        WHERE id=$1 RETURNING campaign_id
      `, [job.campaign_recipient_id, finalFailure ? 'FAILED' : 'QUEUED']);
      campaignId = recipient.rows[0]?.campaign_id;
      if (campaignId) await pool.query('SELECT pedidos_app_crm_refresh_campaign($1)', [campaignId]);
    }
    await pool.query(`UPDATE pedidos_app_crm_provider_state SET last_error_code=$1,last_error_at=NOW(),updated_at=NOW() WHERE provider='WHATSAPP'`, [safeText(error.code || 'WHATSAPP_SEND_FAILED', 80)]);
  }

  async function processOne() {
    if (running || stopped) return false;
    running = true;
    try {
      const job = await claimJob();
      if (!job) return false;
      const gate = await isCampaignSendAllowed(job);
      if (!gate.allowed) { await deferOrCancel(job, gate); return true; }
      try {
        const payload = job.payload || {};
        const response = job.job_type === 'TEMPLATE'
          ? await whatsappClient.sendTemplate(payload)
          : await whatsappClient.sendText(payload);
        await completeJob(job, response);
      } catch (error) { await failJob(job, error); }
      return true;
    } finally { running = false; }
  }

  async function enqueueCampaignBatch() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT recipient.*,campaign.variables,campaign.status AS campaign_status,
          template.name AS template_name,template.language AS template_language,
          contact.normalized_phone,contact.id AS contact_id
        FROM pedidos_app_crm_campaign_recipients recipient
        JOIN pedidos_app_crm_campaigns campaign ON campaign.id=recipient.campaign_id
        JOIN pedidos_app_crm_whatsapp_templates template ON template.id=campaign.template_id AND template.status='APPROVED'
        JOIN pedidos_app_crm_contacts contact ON contact.id=recipient.contact_id
        WHERE campaign.status='RUNNING' AND recipient.status='PENDING'
        ORDER BY recipient.id FOR UPDATE OF recipient SKIP LOCKED LIMIT 100
      `);
      for (const recipient of rows) {
        const conversation = await ensureConversation(client, {
          contactId: recipient.contact_id,
          providerAccountId: whatsappClient.config.phoneNumberId || null,
        });
        const components = buildCampaignTemplateComponents(recipient.variables || {}, recipient.rendered_variables || {});
        const message = await client.query(`
          INSERT INTO pedidos_app_crm_messages
            (conversation_id,contact_id,direction,message_type,content,status,queued_at)
          VALUES ($1,$2,'OUTBOUND','template',$3::jsonb,'QUEUED',NOW()) RETURNING id
        `, [conversation.id, recipient.contact_id, JSON.stringify({ template: recipient.template_name, language: recipient.template_language, components })]);
        await client.query(`
          UPDATE pedidos_app_crm_campaign_recipients SET message_id=$2,status='QUEUED',queued_at=NOW(),updated_at=NOW() WHERE id=$1
        `, [recipient.id, message.rows[0].id]);
        await client.query(`
          INSERT INTO pedidos_app_crm_message_jobs
            (job_key,message_id,campaign_recipient_id,job_type,payload,priority)
          VALUES ($1,$2,$3,'TEMPLATE',$4::jsonb,40)
          ON CONFLICT (job_key) DO NOTHING
        `, [`campaign:${recipient.campaign_id}:${recipient.contact_id}`, message.rows[0].id, recipient.id,
          JSON.stringify({ to: recipient.normalized_phone, name: recipient.template_name, language: recipient.template_language, components })]);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function scheduleTimeAutomations() {
    await pool.query(`
      UPDATE pedidos_app_crm_contacts contact
      SET status='INACTIVO',updated_at=NOW()
      FROM pedidos_app_settings settings
      WHERE settings.id=1 AND contact.deleted_at IS NULL
        AND contact.status NOT IN ('INACTIVO','NO_CONTACTAR')
        AND contact.last_purchase_at IS NOT NULL
        AND contact.last_purchase_at < NOW()-(settings.crm_inactive_days*INTERVAL '1 day')
    `);
    await pool.query(`
      INSERT INTO pedidos_app_crm_automation_runs
        (automation_id,contact_id,trigger_entity_type,trigger_entity_id,run_key,status,scheduled_at)
      SELECT automation.id,contact.id,'CRM_CONTACT',contact.id::text,
        'inactivity:' || automation.id || ':' || contact.id || ':' || CURRENT_DATE,
        'SCHEDULED',NOW()
      FROM pedidos_app_crm_automations automation
      JOIN pedidos_app_crm_contacts contact ON contact.deleted_at IS NULL
      WHERE automation.is_active AND automation.trigger_type='INACTIVITY'
        AND contact.last_purchase_at IS NOT NULL
        AND contact.last_purchase_at < NOW()-(COALESCE((automation.trigger_config->>'days')::int,90)*INTERVAL '1 day')
      ON CONFLICT (run_key) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO pedidos_app_crm_automation_runs
        (automation_id,contact_id,trigger_entity_type,trigger_entity_id,run_key,status,scheduled_at)
      SELECT automation.id,contact.id,'CRM_CONTACT',contact.id::text,
        'no-purchase:' || automation.id || ':' || contact.id || ':' || CURRENT_DATE,
        'SCHEDULED',NOW()
      FROM pedidos_app_crm_automations automation
      JOIN pedidos_app_crm_contacts contact ON contact.deleted_at IS NULL
      WHERE automation.is_active AND automation.trigger_type='NO_PURCHASE_AFTER_CONTACT'
        AND contact.orders_count=0 AND contact.last_contact_at IS NOT NULL
        AND contact.last_contact_at < NOW()-(GREATEST(automation.wait_minutes,1)*INTERVAL '1 minute')
      ON CONFLICT (run_key) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO pedidos_app_crm_automation_runs
        (automation_id,contact_id,trigger_entity_type,trigger_entity_id,run_key,status,scheduled_at)
      SELECT DISTINCT automation.id,contact.id,'CRM_CONTACT',contact.id::text,
        'birthday:' || automation.id || ':' || contact.id || ':' || EXTRACT(YEAR FROM CURRENT_DATE)::int,
        'SCHEDULED',NOW()
      FROM pedidos_app_crm_automations automation
      JOIN pedidos_app_crm_contacts contact ON contact.deleted_at IS NULL
      JOIN pedidos_app_crm_contact_customers link ON link.contact_id=contact.id
      JOIN pedidos_app_customers customer ON customer.id=link.customer_id
      WHERE automation.is_active AND automation.trigger_type='BIRTHDAY'
        AND EXTRACT(MONTH FROM customer.birthday)=EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY FROM customer.birthday)=EXTRACT(DAY FROM CURRENT_DATE)
      ON CONFLICT (run_key) DO NOTHING
    `);
  }

  async function processAutomationRun() {
    const client = await pool.connect();
    let currentRunId = null;
    try {
      await client.query('BEGIN');
      const runResult = await client.query(`
        SELECT run.*,automation.conditions,automation.action_type,automation.action_config
        FROM pedidos_app_crm_automation_runs run
        JOIN pedidos_app_crm_automations automation ON automation.id=run.automation_id AND automation.is_active
        WHERE run.status='SCHEDULED' AND run.scheduled_at<=NOW()
        ORDER BY run.scheduled_at,run.id FOR UPDATE OF run SKIP LOCKED LIMIT 1
      `);
      if (!runResult.rows.length) { await client.query('COMMIT'); return false; }
      const run = runResult.rows[0];
      currentRunId = run.id;
      await client.query(`UPDATE pedidos_app_crm_automation_runs SET status='RUNNING',started_at=NOW() WHERE id=$1`, [run.id]);
      const rules = Array.isArray(run.conditions?.rules) ? run.conditions.rules : [];
      if (rules.length) {
        const compiled = compileSegment(run.conditions, { startAt: 2 });
        const matches = await client.query(`SELECT 1 FROM pedidos_app_crm_contacts contact WHERE contact.id=$1 AND contact.deleted_at IS NULL AND ${compiled.sql}`, [run.contact_id, ...compiled.params]);
        if (!matches.rowCount) {
          await client.query(`UPDATE pedidos_app_crm_automation_runs SET status='CANCELLED',cancelled_at=NOW(),result='{"reason":"CONDITIONS_NOT_MET"}'::jsonb WHERE id=$1`, [run.id]);
          await client.query('COMMIT');
          return true;
        }
      }
      const action = run.action_config || {};
      let result = {};
      if (run.action_type === 'ADD_TAG') {
        if (!Number.isInteger(Number(action.tag_id))) throw crmError('AUTOMATION_INVALID', 'La automatización no tiene una etiqueta válida.', 400);
        await client.query(`INSERT INTO pedidos_app_crm_contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [run.contact_id, action.tag_id]);
        result = { tagId: Number(action.tag_id) };
      } else if (run.action_type === 'SET_STATUS') {
        const statuses = ['NUEVO_CONTACTO','PROSPECTO','CLIENTE_NUEVO','CLIENTE_RECURRENTE','CLIENTE_FRECUENTE','VIP','INACTIVO','RECUPERADO','NO_CONTACTAR'];
        if (!statuses.includes(action.status)) throw crmError('AUTOMATION_INVALID', 'La automatización no tiene un estado CRM válido.', 400);
        await client.query(`UPDATE pedidos_app_crm_contacts SET status=$2,updated_at=NOW() WHERE id=$1`, [run.contact_id, action.status]);
        result = { status: action.status };
      } else if (run.action_type === 'ASSIGN_USER') {
        if (!Number.isInteger(Number(action.user_id))) throw crmError('AUTOMATION_INVALID', 'La automatización no tiene un usuario válido.', 400);
        await client.query(`UPDATE pedidos_app_crm_contacts SET assigned_user_id=$2,updated_at=NOW() WHERE id=$1`, [run.contact_id, action.user_id]);
        result = { assignedUserId: Number(action.user_id) };
      } else if (run.action_type === 'ENROLL_CAMPAIGN') {
        const campaign = await client.query(`SELECT id,status FROM pedidos_app_crm_campaigns WHERE id=$1 AND status IN('RUNNING','SCHEDULED')`, [action.campaign_id]);
        if (!campaign.rows.length) throw crmError('AUTOMATION_INVALID', 'La campaña de la automatización no está activa.', 409);
        const contact = await client.query(`SELECT marketing_opt_in,marketing_opt_out,no_contact FROM pedidos_app_crm_contacts WHERE id=$1`, [run.contact_id]);
        const eligible = contact.rows[0]?.marketing_opt_in && !contact.rows[0]?.marketing_opt_out && !contact.rows[0]?.no_contact;
        await client.query(`
          INSERT INTO pedidos_app_crm_campaign_recipients(campaign_id,contact_id,status,exclusion_reason,rendered_variables)
          SELECT $1,contact.id,CASE WHEN $3 THEN 'PENDING' ELSE 'EXCLUDED' END,CASE WHEN $3 THEN NULL ELSE 'MARKETING_CONSENT_REQUIRED' END,
            jsonb_build_object('contact.name',COALESCE(contact.display_name,''),'contact.phone',contact.normalized_phone,'contact.barrio',COALESCE(contact.barrio,''),'contact.orders_count',contact.orders_count,'contact.total_spent',contact.total_spent)
          FROM pedidos_app_crm_contacts contact WHERE contact.id=$2
          ON CONFLICT(campaign_id,contact_id) DO NOTHING
        `, [action.campaign_id, run.contact_id, eligible]);
        result = { campaignId: Number(action.campaign_id), eligible: Boolean(eligible) };
      }
      await client.query(`UPDATE pedidos_app_crm_automation_runs SET status='COMPLETED',completed_at=NOW(),result=$2::jsonb WHERE id=$1`, [run.id, JSON.stringify(result)]);
      await client.query(`UPDATE pedidos_app_crm_automations SET last_run_at=NOW() WHERE id=$1`, [run.automation_id]);
      await client.query(`INSERT INTO pedidos_app_crm_activities(contact_id,activity_type,entity_type,entity_id,summary,metadata) VALUES($1,'AUTOMATION_COMPLETED','CRM_AUTOMATION',$2,'Automatización ejecutada',$3::jsonb)`, [run.contact_id, String(run.automation_id), JSON.stringify(result)]);
      await appendCrmEvent(client, 'crm.automation.completed', 'crm_contact', run.contact_id, { contactId: Number(run.contact_id), automationId: Number(run.automation_id), runId: Number(run.id) });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (currentRunId) await pool.query(`UPDATE pedidos_app_crm_automation_runs SET status='FAILED',error_code=$2,error_message=$3 WHERE id=$1`, [currentRunId, error.code || 'AUTOMATION_FAILED', safeText(error.message,500)]).catch(() => {});
      console.error(JSON.stringify({ level: 'error', component: 'crm-automation', run_id: currentRunId, code: error.code || 'AUTOMATION_FAILED', message: error.message }));
      return Boolean(currentRunId);
    } finally { client.release(); }
  }

  async function handleDomainEvent(event) {
    if (event.aggregate_type !== 'order') return 0;
    const status = event.payload?.orderStatus;
    if (event.event_type !== 'order_delivered' && !(event.event_type === 'order_status_changed' && ['Entregado','Completado'].includes(status))) return 0;
    const { rows } = await pool.query('SELECT crm_contact_id FROM pedidos_app_orders WHERE id=$1', [event.aggregate_id]);
    if (!rows[0]?.crm_contact_id) return 0;
    return scheduleEventAutomations(pool, 'ORDER_COMPLETED', rows[0].crm_contact_id, 'ORDER', event.aggregate_id);
  }

  async function scheduleCampaigns() {
    await processPendingWhatsAppWebhooks(pool);
    await pool.query(`UPDATE pedidos_app_crm_campaigns SET status='RUNNING',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE status='SCHEDULED' AND scheduled_at<=NOW()`);
    await pool.query(`
      UPDATE pedidos_app_crm_campaigns campaign SET status='COMPLETED',completed_at=NOW(),updated_at=NOW()
      WHERE campaign.status='RUNNING' AND EXISTS (SELECT 1 FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=campaign.id)
        AND NOT EXISTS (SELECT 1 FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=campaign.id AND status IN ('PENDING','QUEUED','SENDING'))
    `);
    await enqueueCampaignBatch();
    if (Date.now() - lastAutomationSweepAt >= 60_000) {
      await scheduleTimeAutomations();
      lastAutomationSweepAt = Date.now();
    }
    await processAutomationRun();
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    await pool.query(`
      UPDATE pedidos_app_crm_message_jobs SET status='RETRY',available_at=NOW(),locked_at=NULL,locked_by=NULL
      WHERE status='PROCESSING' AND locked_at<NOW()-INTERVAL '10 minutes'
    `);
    await pool.query(`
      UPDATE pedidos_app_crm_provider_state SET configured=$1,display_phone_masked=$2,updated_at=NOW() WHERE provider='WHATSAPP'
    `, [whatsappClient.isConfigured(), whatsappClient.config.phoneNumberId ? `••••${whatsappClient.config.phoneNumberId.slice(-4)}` : null]);
    timer = setInterval(() => { void processOne(); }, intervalMs);
    sweepingTimer = setInterval(() => {
      void scheduleCampaigns().catch((error) => console.error(JSON.stringify({ level: 'error', component: 'crm-sweep', message: error.message })));
    }, 5_000);
    timer.unref?.();
    sweepingTimer.unref?.();
    await scheduleCampaigns();
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearInterval(sweepingTimer);
    timer = null;
    sweepingTimer = null;
  }

  return { start, stop, processOne, scheduleCampaigns, enqueueCampaignBatch, processAutomationRun, handleDomainEvent, instanceId };
}

module.exports = {
  appendCrmEvent,
  buildCampaignTemplateComponents,
  createCrmWorker,
  crmError,
  ensureContact,
  ensureConversation,
  processPendingWhatsAppWebhooks,
  processStoredWhatsAppWebhook,
  processWhatsAppWebhook,
  registerWhatsAppWebhook,
  queueConversationMessage,
  scheduleEventAutomations,
};
