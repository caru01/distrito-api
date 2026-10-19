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

function maskIdentifier(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  if (str.length <= 4) return '****';
  return `${str.slice(0, 3)}***${str.slice(-4)}`;
}

function logCrmTrace(event, fields = {}, level = 'info') {
  if (process.env.CRM_SILENT_LOGS === 'true') return;
  const record = {
    level,
    component: 'crm-pipeline',
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  if (level === 'error') console.error(JSON.stringify(record));
  else console.log(JSON.stringify(record));
}

function parseMessageTimestamp(message, fallbackTime = null) {
  const candidates = [
    message?.sendTime,
    message?.createTime,
    message?.sendAt,
    message?.createdAt,
    message?.timestamp,
    message?.deliverTime,
    message?.readTime,
    message?.updateTime,
    message?.updatedAt,
    message?.deliverAt,
    fallbackTime,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
    const str = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(str)) {
      const num = Number(str);
      const ms = num < 1e11 ? Math.round(num * 1000) : Math.round(num);
      const dt = new Date(ms);
      if (!Number.isNaN(dt.getTime()) && dt.getFullYear() >= 2020) return dt;
    } else {
      const dt = new Date(str);
      if (!Number.isNaN(dt.getTime()) && dt.getFullYear() >= 2020) return dt;
    }
  }
  return new Date();
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

function extractMessageText(message = {}) {
  const type = String(message.type || '').toLowerCase();
  if (type === 'text') return safeText(message.text?.body ?? message.text);
  if (type === 'template') {
    const bodyComp = Array.isArray(message.template?.components)
      ? message.template.components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')
      : null;
    if (bodyComp?.text) return safeText(bodyComp.text);
    return safeText(message.template?.name ? `[Plantilla: ${message.template.name}]` : '[Plantilla]');
  }
  if (type === 'button') return safeText(message.button?.text || message.button?.payload || '[Botón]');
  if (type === 'interactive') {
    return safeText(
      message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || message.interactive?.nfm_reply?.body
      || message.interactive?.body?.text
      || '[Interactivo]'
    );
  }
  if (['image', 'video', 'document', 'audio', 'sticker'].includes(type)) {
    const mediaLabels = { image: '[Imagen]', video: '[Video]', document: '[Documento]', audio: '[Audio]', sticker: '[Sticker]' };
    return safeText(message[type]?.caption || message[type]?.filename || mediaLabels[type] || `[${type}]`);
  }
  if (type === 'location') return safeText(message.location?.name || message.location?.address || '[Ubicación]');
  if (type === 'reaction') return safeText(message.reaction?.emoji ? `Reacción ${message.reaction.emoji}` : '[Reacción]');
  if (type === 'contacts') {
    const firstContact = Array.isArray(message.contacts) ? message.contacts[0] : null;
    const formattedName = firstContact?.name?.formatted_name || firstContact?.name?.first_name;
    return safeText(formattedName ? `[Contacto: ${formattedName}]` : '[Contacto compartido]');
  }
  if (type === 'order') return '[Pedido de catálogo]';
  if (type === 'system' || type === 'unsupported') {
    return safeText(message.system?.body || message.errors?.[0]?.title || message.errors?.[0]?.message || `[${type}]`, 300);
  }
  return `[${safeText(message.type || 'mensaje', 30)}]`;
}

function publicMessageContent(message = {}) {
  const type = safeText(message.type || 'unknown', 20).toLowerCase();
  const source = message[type] || {};
  const base = {};
  if (message.wamid) base.wamid = safeText(message.wamid, 180);
  if (type === 'location') {
    return { ...base, latitude: source.latitude, longitude: source.longitude, name: safeText(source.name, 200), address: safeText(source.address, 300) };
  }
  if (['image', 'audio', 'video', 'document', 'sticker'].includes(type)) {
    return {
      ...base,
      mediaId: safeText(source.id, 180),
      mimeType: safeText(source.mime_type || source.mimeType, 120),
      filename: safeText(source.filename, 240),
      caption: safeText(source.caption, 1000),
      sha256: safeText(source.sha256, 128),
      // Enlace firmado de YCloud: permite al CRM mostrar el archivo mediante el proxy autenticado.
      link: safeText(source.link || source.url, 2000) || null,
      voice: source.voice === true,
    };
  }
  if (type === 'interactive') return { ...base, interactive: source };
  if (type === 'reaction') return { ...base, emoji: safeText(source.emoji, 32), messageId: safeText(source.message_id || source.messageId, 180) };
  if (type === 'contacts') return { ...base, contacts: Array.isArray(message.contacts) ? message.contacts.slice(0, 5) : [] };
  if (type === 'button') return { ...base, payload: safeText(source.payload, 250), text: safeText(source.text, 250) };
  return base;
}

function buildCampaignTemplateComponents(configuration = {}, renderedValues = {}) {
  const allowedSources = new Set([
    'contact.name','contact.phone','contact.barrio','contact.orders_count','contact.total_spent',
  ]);
  const components = [];

  // ── Header media (image / video / document) ──────────────────────────
  const headerMedia = configuration.header_image || configuration.header_video || configuration.header_document;
  if (headerMedia) {
    const url = String(headerMedia).trim();
    if (url && /^https:\/\/.+/i.test(url)) {
      const mediaType = configuration.header_image ? 'image'
        : configuration.header_video ? 'video' : 'document';
      components.push({ type: 'header', parameters: [{ type: mediaType, [mediaType]: { link: url } }] });
    }
  } else if (Array.isArray(configuration.header) && configuration.header.length) {
    // Header con variables de texto (comportamiento original preservado)
    const parameters = configuration.header.map((source) => {
      const normalized = String(source || '');
      if (!allowedSources.has(normalized)) throw crmError('WHATSAPP_TEMPLATE_INVALID', `Variable no permitida: ${normalized || '(vacía)'}.`, 400);
      return { type: 'text', text: String(renderedValues[normalized] ?? '').slice(0, 1024) };
    });
    components.push({ type: 'header', parameters });
  }

  // ── Body (sin cambios respecto al original) ──────────────────────────
  if (Array.isArray(configuration.body) && configuration.body.length) {
    const parameters = configuration.body.map((source) => {
      const normalized = String(source || '');
      if (!allowedSources.has(normalized)) throw crmError('WHATSAPP_TEMPLATE_INVALID', `Variable no permitida: ${normalized || '(vacía)'}.`, 400);
      let val = String(renderedValues[normalized] ?? '').trim();
      if (!val && normalized === 'contact.name') val = 'amig@';
      if (!val) val = '-';
      return { type: 'text', text: val.slice(0, 1024) };
    });
    components.push({ type: 'body', parameters });
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

function isConsumidorFinalIdentifier(phone, bsuid) {
  const rawDigits = String(phone || '').replace(/\D+/g, '');
  const cleanBsuid = String(bsuid || '').trim().toUpperCase();
  return rawDigits === '2222222' || rawDigits === '572222222' || cleanBsuid === 'CONSUMIDOR_FINAL';
}

async function ensureContactOnce(client, { phone = null, bsuid = null, username = null, name = null, source = 'WHATSAPP', email = null, address = null, barrio = null, occurredAt = null }) {
  const safeSource = safeText(source, 40) || 'OTRO';
  if (safeSource === 'WHATSAPP' && isConsumidorFinalIdentifier(phone, bsuid)) {
    throw crmError('CRM_PHONE_INVALID', 'El contacto CONSUMIDOR FINAL es exclusivo de ventas presenciales y no puede vincularse a chats de WhatsApp.', 400);
  }

  const normalizedPhone = normalizePhoneE164(phone);
  const safeBsuid = safeText(bsuid, 128) || null;
  const safeUsername = safeText(username, 128) || null;
  const safeName = safeText(name, 255) || null;
  const contactTime = occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime()) ? occurredAt : new Date();

  // Validar: se necesita al menos teléfono O bsuid
  if (!normalizedPhone && !safeBsuid) {
    throw crmError('CRM_PHONE_INVALID', 'El teléfono no se puede normalizar a E.164.', 400);
  }

  let contact = null;

  // ── Resolución por BSUID (prioridad alta) ───────────────────────────────
  if (safeBsuid) {
    const byBsuidResult = await client.query(
      'SELECT * FROM pedidos_app_crm_contacts WHERE bsuid=$1 LIMIT 1',
      [safeBsuid]
    );
    const byPhoneResult = normalizedPhone
      ? await client.query('SELECT * FROM pedidos_app_crm_contacts WHERE normalized_phone=$1 LIMIT 1', [normalizedPhone])
      : { rows: [] };
    const byBsuid = byBsuidResult.rows[0] || null;
    const byPhone = byPhoneResult.rows[0] || null;

    if (byBsuid && byPhone && Number(byBsuid.id) !== Number(byPhone.id) && byBsuid.bsuid !== 'CONSUMIDOR_FINAL' && byPhone.bsuid !== 'CONSUMIDOR_FINAL') {
      // El mismo cliente existe dos veces (uno por BSUID, otro por teléfono): se unifican en el contacto con teléfono.
      contact = await mergeContacts(client, byPhone.id, byBsuid.id);
    } else if (byBsuid) {
      contact = byBsuid;
      const updated = await client.query(`
        UPDATE pedidos_app_crm_contacts SET
          normalized_phone=COALESCE(normalized_phone,$2),
          display_name=COALESCE(NULLIF($3,''),display_name),
          username=COALESCE(NULLIF($4,''),username),
          marketing_opt_in=TRUE,
          deleted_at=CASE WHEN bsuid LIKE 'MERGED:%' THEN deleted_at ELSE NULL END,
          first_contact_at=LEAST(COALESCE(first_contact_at,$5::timestamptz),$5::timestamptz),
          last_contact_at=GREATEST(COALESCE(last_contact_at,$5::timestamptz),$5::timestamptz),
          updated_at=NOW()
        WHERE id=$1
        RETURNING *
      `, [contact.id, normalizedPhone, safeName, safeUsername, contactTime]);
      contact = updated.rows[0] || contact;
    } else if (byPhone) {
      contact = byPhone;
      const updated = await client.query(`
        UPDATE pedidos_app_crm_contacts SET
          bsuid=COALESCE(bsuid,$2),
          display_name=COALESCE(NULLIF($3,''),display_name),
          username=COALESCE(NULLIF($4,''),username),
          marketing_opt_in=TRUE,
          deleted_at=CASE WHEN bsuid LIKE 'MERGED:%' THEN deleted_at ELSE NULL END,
          first_contact_at=LEAST(COALESCE(first_contact_at,$5::timestamptz),$5::timestamptz),
          last_contact_at=GREATEST(COALESCE(last_contact_at,$5::timestamptz),$5::timestamptz),
          updated_at=NOW()
        WHERE id=$1
        RETURNING *
      `, [contact.id, safeBsuid, safeName, safeUsername, contactTime]);
      contact = updated.rows[0] || contact;
    }

    if (!contact) {
      // Nuevo contacto con bsuid (puede que sin teléfono)
      const inserted = await client.query(`
        INSERT INTO pedidos_app_crm_contacts
          (normalized_phone,bsuid,username,display_name,email,address,barrio,source,
           first_contact_at,last_contact_at,status,marketing_opt_in)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'PROSPECTO',TRUE)
        RETURNING *
      `, [normalizedPhone, safeBsuid, safeUsername, safeName,
          safeText(email, 255) || null, safeText(address, 1000) || null,
          safeText(barrio, 255) || null, safeSource, contactTime]);
      contact = inserted.rows[0];
    }
  } else {
    // ── Resolución solo por teléfono (flujo original con protección de fechas y deleted_at) ───────────
    const { rows } = await client.query(`
      INSERT INTO pedidos_app_crm_contacts
        (normalized_phone,display_name,email,address,barrio,source,first_contact_at,last_contact_at,status,marketing_opt_in)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'PROSPECTO',TRUE)
      ON CONFLICT (normalized_phone) DO UPDATE SET
        display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),pedidos_app_crm_contacts.display_name),
        email=COALESCE(NULLIF(EXCLUDED.email,''),pedidos_app_crm_contacts.email),
        address=COALESCE(NULLIF(EXCLUDED.address,''),pedidos_app_crm_contacts.address),
        barrio=COALESCE(NULLIF(EXCLUDED.barrio,''),pedidos_app_crm_contacts.barrio),
        marketing_opt_in=TRUE,
        deleted_at=CASE WHEN pedidos_app_crm_contacts.bsuid LIKE 'MERGED:%' THEN pedidos_app_crm_contacts.deleted_at ELSE NULL END,
        first_contact_at=LEAST(COALESCE(pedidos_app_crm_contacts.first_contact_at,EXCLUDED.first_contact_at),EXCLUDED.first_contact_at),
        last_contact_at=GREATEST(COALESCE(pedidos_app_crm_contacts.last_contact_at,EXCLUDED.last_contact_at),EXCLUDED.last_contact_at),
        updated_at=NOW()
      RETURNING *
    `, [normalizedPhone, safeName, safeText(email, 255) || null,
        safeText(address, 1000) || null, safeText(barrio, 255) || null, safeSource, contactTime]);
    contact = rows[0];
  }

  // Vincular con pedidos_app_customers si hay teléfono
  if (normalizedPhone) {
    await client.query(`
      INSERT INTO pedidos_app_crm_contact_customers (contact_id,customer_id)
      SELECT $1,id FROM pedidos_app_customers WHERE phone_e164=$2
      ON CONFLICT (customer_id) DO UPDATE SET contact_id=EXCLUDED.contact_id
    `, [contact.id, normalizedPhone]);
  }

  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.id]);
  return contact;
}

// Ejecuta fn dentro de un SAVEPOINT cuando hay una transacción activa (si no la hay, la ejecuta directamente).
async function withSavepoint(client, name, fn) {
  let active = true;
  try {
    await client.query(`SAVEPOINT ${name}`);
  } catch (error) {
    if (error.code !== '25P01') throw error;
    active = false;
  }
  try {
    const result = await fn();
    if (active) await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    if (active) await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    throw error;
  }
}

// Une dos contactos que representan a la misma persona (p. ej. chat por BSUID + cliente con teléfono).
// Conserva el contacto keepId, mueve conversaciones, mensajes, pedidos y demás historial desde dropId
// y deja dropId oculto (deleted_at) sin identificadores únicos. No borra información.
async function mergeContacts(client, keepId, dropId, { actorUserId = null } = {}) {
  const keepNumber = Number(keepId);
  const dropNumber = Number(dropId);
  if (keepNumber === dropNumber) {
    return (await client.query('SELECT * FROM pedidos_app_crm_contacts WHERE id=$1', [keepNumber])).rows[0];
  }
  const locked = await client.query(
    'SELECT * FROM pedidos_app_crm_contacts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE',
    [keepNumber, dropNumber]
  );
  const keep = locked.rows.find((row) => Number(row.id) === keepNumber);
  const drop = locked.rows.find((row) => Number(row.id) === dropNumber);
  if (!keep || !drop) throw crmError('CRM_CONTACT_NOT_FOUND', 'Contacto no encontrado para unificar.', 404);

  // 1) Liberar identificadores únicos del contacto absorbido y ocultarlo (conservando un bsuid sintético para cumplir crm_contacts_identity_check).
  await client.query(
    'UPDATE pedidos_app_crm_contacts SET normalized_phone=NULL,bsuid=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1',
    [dropNumber, `MERGED:${dropNumber}`]
  );

  // 2) Enriquecer el contacto conservado (nunca se pierde una baja comercial).
  await client.query(`
    UPDATE pedidos_app_crm_contacts SET
      normalized_phone=COALESCE(normalized_phone,$2),
      bsuid=COALESCE(bsuid,$3),
      username=COALESCE(NULLIF(username,''),$4),
      display_name=COALESCE(NULLIF(display_name,''),$5),
      email=COALESCE(NULLIF(email,''),$6),
      address=COALESCE(NULLIF(address,''),$7),
      barrio=COALESCE(NULLIF(barrio,''),$8),
      primary_customer_id=COALESCE(primary_customer_id,$9),
      first_contact_at=LEAST(first_contact_at,$10::timestamptz),
      last_contact_at=GREATEST(last_contact_at,$11::timestamptz),
      marketing_opt_out=marketing_opt_out OR $12::boolean,
      no_contact=no_contact OR $13::boolean,
      updated_at=NOW()
    WHERE id=$1
  `, [keepNumber, drop.normalized_phone, drop.bsuid, drop.username, drop.display_name, drop.email, drop.address,
    drop.barrio, drop.primary_customer_id, drop.first_contact_at, drop.last_contact_at,
    Boolean(drop.marketing_opt_out), Boolean(drop.no_contact)]);

  // 3) Mover el historial. Cada paso es independiente: si uno falla se registra y el resto continúa.
  const move = async (label, sql) => {
    try {
      await withSavepoint(client, `crm_merge_${label}`, () => client.query(sql, [keepNumber, dropNumber]));
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', component: 'crm-merge', step: label, message: error.message }));
    }
  };

  // Conversaciones: solo puede existir una activa por contacto/canal.
  try {
    await withSavepoint(client, 'crm_merge_conversations', async () => {
      const keepActive = await client.query(`
        SELECT id FROM pedidos_app_crm_conversations
        WHERE contact_id=$1 AND channel='WHATSAPP' AND status IN ('OPEN','PENDING') ORDER BY id DESC LIMIT 1
      `, [keepNumber]);
      let activeId = keepActive.rows[0]?.id || null;
      const dropConversations = await client.query(
        'SELECT * FROM pedidos_app_crm_conversations WHERE contact_id=$1 ORDER BY id',
        [dropNumber]
      );
      for (const conversation of dropConversations.rows) {
        const isActive = ['OPEN', 'PENDING'].includes(conversation.status) && conversation.channel === 'WHATSAPP';
        if (isActive && activeId) {
          await client.query(
            'UPDATE pedidos_app_crm_messages SET conversation_id=$1,contact_id=$2 WHERE conversation_id=$3',
            [activeId, keepNumber, conversation.id]
          );
          await client.query(`
            UPDATE pedidos_app_crm_conversations SET
              unread_count=unread_count+$2,
              first_message_at=LEAST(first_message_at,$3::timestamptz),
              last_message_at=GREATEST(last_message_at,$4::timestamptz),
              last_inbound_at=GREATEST(last_inbound_at,$5::timestamptz),
              last_outbound_at=GREATEST(last_outbound_at,$6::timestamptz),
              updated_at=NOW()
            WHERE id=$1
          `, [activeId, Number(conversation.unread_count) || 0, conversation.first_message_at,
            conversation.last_message_at, conversation.last_inbound_at, conversation.last_outbound_at]);
          await withSavepoint(client, 'crm_merge_drop_conversation', async () => {
            await client.query('DELETE FROM pedidos_app_crm_conversations WHERE id=$1', [conversation.id]);
          }).catch(async () => {
            await client.query(
              `UPDATE pedidos_app_crm_conversations SET status='CLOSED',closed_at=NOW(),contact_id=$2 WHERE id=$1`,
              [conversation.id, keepNumber]
            );
          });
        } else {
          await client.query('UPDATE pedidos_app_crm_conversations SET contact_id=$2 WHERE id=$1', [conversation.id, keepNumber]);
          if (isActive) activeId = conversation.id;
        }
      }
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', component: 'crm-merge', step: 'conversations', message: error.message }));
  }

  await move('messages', 'UPDATE pedidos_app_crm_messages SET contact_id=$1 WHERE contact_id=$2');
  await move('orders', 'UPDATE pedidos_app_orders SET crm_contact_id=$1 WHERE crm_contact_id=$2');
  await move('activities', 'UPDATE pedidos_app_crm_activities SET contact_id=$1 WHERE contact_id=$2');
  await move('attributions', 'UPDATE pedidos_app_crm_attributions SET contact_id=$1 WHERE contact_id=$2');
  await move('automation_runs', 'UPDATE pedidos_app_crm_automation_runs SET contact_id=$1 WHERE contact_id=$2');
  await move('consents', 'UPDATE pedidos_app_crm_consents SET contact_id=$1 WHERE contact_id=$2');
  await move('notes', 'UPDATE pedidos_app_crm_notes SET contact_id=$1 WHERE contact_id=$2');
  await move('interests', 'UPDATE pedidos_app_crm_contact_interests SET contact_id=$1 WHERE contact_id=$2');
  await move('tags', `
    INSERT INTO pedidos_app_crm_contact_tags (contact_id,tag_id,assigned_by)
    SELECT $1,tag_id,assigned_by FROM pedidos_app_crm_contact_tags WHERE contact_id=$2
    ON CONFLICT DO NOTHING
  `);
  await move('segments', `
    UPDATE pedidos_app_crm_segment_members member SET contact_id=$1
    WHERE member.contact_id=$2 AND NOT EXISTS (
      SELECT 1 FROM pedidos_app_crm_segment_members other WHERE other.segment_id=member.segment_id AND other.contact_id=$1
    )
  `);
  await move('recipients', `
    UPDATE pedidos_app_crm_campaign_recipients recipient SET contact_id=$1
    WHERE recipient.contact_id=$2 AND NOT EXISTS (
      SELECT 1 FROM pedidos_app_crm_campaign_recipients other WHERE other.campaign_id=recipient.campaign_id AND other.contact_id=$1
    )
  `);
  await move('customers', `
    UPDATE pedidos_app_crm_contact_customers link SET contact_id=$1
    WHERE link.contact_id=$2 AND NOT EXISTS (
      SELECT 1 FROM pedidos_app_crm_contact_customers other WHERE other.contact_id=$1 AND other.customer_id=link.customer_id
    )
  `);

  await client.query(`
    INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,actor_user_id,summary,metadata)
    VALUES ($1,'CONTACT_MERGED','CRM_CONTACT',$2,$3,'Contactos unificados (misma persona)',$4::jsonb)
  `, [keepNumber, String(keepNumber), actorUserId, JSON.stringify({ mergedContactId: dropNumber })]);
  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [keepNumber]);
  await appendCrmEvent(client, 'crm.contact.merged', 'crm_contact', keepNumber, { contactId: keepNumber, mergedContactId: dropNumber });
  return (await client.query('SELECT * FROM pedidos_app_crm_contacts WHERE id=$1', [keepNumber])).rows[0];
}

// Resuelve (o crea) el contacto. Ante una carrera de concurrencia (dos webhooks del mismo cliente
// al mismo tiempo) la violación de unicidad se reintenta y encuentra el contacto recién creado.
async function ensureContact(client, input) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withSavepoint(client, 'crm_ensure_contact', () => ensureContactOnce(client, input));
    } catch (error) {
      if (error.code === '23505' && attempt < 2) continue;
      throw error;
    }
  }
}

async function ensureConversation(client, { contactId, providerAccountId = null, assignedUserId = null, occurredAt = null }) {
  const initialTime = occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime()) ? occurredAt : new Date();
  const inserted = await client.query(`
    INSERT INTO pedidos_app_crm_conversations
      (contact_id,channel,provider_account_id,status,assigned_user_id,first_message_at,last_message_at)
    VALUES ($1,'WHATSAPP',$2,'OPEN',$3,$4,$4)
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [contactId, providerAccountId, assignedUserId, initialTime]);
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

const VALID_INBOUND_MESSAGE_TYPES = new Set([
  'text','image','audio','video','document','sticker','location','interactive','button','reaction','contacts','order','template','system','unsupported',
]);

async function processInboundMessage(client, value, message, contactProfile, fallbackTime = null) {
  if (!message || typeof message !== 'object') {
    throw crmError('WHATSAPP_WEBHOOK_INVALID', 'El payload del mensaje entrante está vacío o es inválido.', 400);
  }
  const occurredAt = parseMessageTimestamp(message, fallbackTime);

  // Extraer teléfono — solo si es numérico tras limpiar prefijos whatsapp: y +
  const rawFrom = String(message.from || contactProfile?.wa_id || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();
  const phone = /^\d+$/.test(rawFrom) ? rawFrom : null;

  // Extraer BSUID (Business-Scoped User ID) — llega cuando el número está oculto
  const bsuid = message.fromUserId || contactProfile?.fromUserId || message.userId || (!phone && rawFrom.length > 4 ? rawFrom : null);

  // Extraer username (@Ricaurte_blanco) — solo para display, nunca como identificador
  const username = contactProfile?.username || message.customerProfile?.username || null;
  const contactName = contactProfile?.profile?.name || contactProfile?.name || message.customerProfile?.name || username || '';

  const contact = await ensureContact(client, {
    phone,
    bsuid,
    username,
    name: contactName,
    source: 'WHATSAPP',
    occurredAt,
  });

  const providerAccountId = safeText(
    value?.metadata?.phone_number_id
    || value?.metadata?.display_phone_number
    || message.to?.replace(/^whatsapp:/i, '')
    || message.wabaId
    || '',
    120
  ) || null;

  const conversation = await ensureConversation(client, {
    contactId: contact.id,
    providerAccountId,
    occurredAt,
  });

  const rawType = String(message.type || 'unknown').toLowerCase();
  const type = VALID_INBOUND_MESSAGE_TYPES.has(rawType) ? rawType : 'unknown';
  const providerMessageId = safeText(message.id || message.wamid, 180) || `inbound:${hashPayload(message).slice(0, 32)}`;
  const contextId = safeText(message.context?.id || message.context?.message_id || message.reaction?.message_id, 180) || null;

  const inserted = await client.query(`
    INSERT INTO pedidos_app_crm_messages
      (conversation_id,contact_id,provider_message_id,context_provider_message_id,direction,message_type,
       text_body,content,status,received_at,created_at)
    VALUES ($1,$2,$3,$4,'INBOUND',$5,$6,$7::jsonb,'RECEIVED',$8,$8)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    conversation.id,
    contact.id,
    providerMessageId,
    contextId,
    type,
    extractMessageText(message),
    JSON.stringify(publicMessageContent(message)),
    occurredAt,
  ]);

  if (!inserted.rowCount) {
    logCrmTrace('inbound_message_duplicate', {
      contact_id: Number(contact.id),
      conversation_id: Number(conversation.id),
      provider_message_id: providerMessageId,
    });
    return { duplicate: true, contactId: contact.id, conversationId: conversation.id };
  }

  const messageId = inserted.rows[0].id;

  await client.query(`
    UPDATE pedidos_app_crm_conversations
    SET unread_count=unread_count+1,
        first_message_at=LEAST(COALESCE(first_message_at,$2::timestamptz),$2::timestamptz),
        last_message_at=GREATEST(COALESCE(last_message_at,$2::timestamptz),$2::timestamptz),
        last_inbound_at=GREATEST(COALESCE(last_inbound_at,$2::timestamptz),$2::timestamptz),
        status='OPEN',
        closed_at=NULL,
        updated_at=NOW()
    WHERE id=$1
  `, [conversation.id, occurredAt]);

  await client.query(`
    UPDATE pedidos_app_crm_contacts
    SET first_contact_at=LEAST(COALESCE(first_contact_at,$2::timestamptz),$2::timestamptz),
        last_contact_at=GREATEST(COALESCE(last_contact_at,$2::timestamptz),$2::timestamptz),
        deleted_at=CASE WHEN bsuid LIKE 'MERGED:%' THEN deleted_at ELSE NULL END,
        updated_at=NOW()
    WHERE id=$1
  `, [contact.id, occurredAt]);

  await client.query(`
    UPDATE pedidos_app_crm_provider_state
    SET webhook_connected=TRUE,
        number_connected=TRUE,
        last_webhook_at=NOW(),
        last_inbound_at=GREATEST(COALESCE(last_inbound_at,$1::timestamptz),$1::timestamptz),
        updated_at=NOW()
    WHERE provider='WHATSAPP'
  `, [occurredAt]);

  await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.id]);
  await client.query(`
    INSERT INTO pedidos_app_crm_activities
      (contact_id,activity_type,entity_type,entity_id,summary,metadata,occurred_at)
    VALUES ($1,'MESSAGE_RECEIVED','CRM_MESSAGE',$2,$3,$4::jsonb,$5)
  `, [contact.id, String(messageId), `Mensaje ${type} recibido por WhatsApp`,
    JSON.stringify({ conversationId: conversation.id, messageType: type }), occurredAt]);

  const domainEventId = await appendCrmEvent(client, 'whatsapp.message.received', 'crm_conversation', conversation.id, {
    contactId: Number(contact.id),
    conversationId: Number(conversation.id),
    messageId: Number(messageId),
  });

  await scheduleEventAutomations(client, 'CONTACT_CREATED', contact.id, 'CRM_CONTACT', contact.id);
  await scheduleEventAutomations(client, 'MESSAGE_RECEIVED', contact.id, 'CRM_MESSAGE', messageId);

  logCrmTrace('inbound_message_persisted', {
    contact_id: Number(contact.id),
    conversation_id: Number(conversation.id),
    message_id: Number(messageId),
    message_type: type,
    sender_masked: maskIdentifier(phone || bsuid),
    occurred_at: occurredAt.toISOString(),
    domain_event_id: domainEventId,
  });

  return { duplicate: false, contactId: contact.id, conversationId: conversation.id, messageId };
}

async function processMessageStatus(client, statusEvent, fallbackTime = null) {
  const nextStatus = MESSAGE_STATUS[String(statusEvent?.status || '').toLowerCase()];
  const primaryId = safeText(statusEvent?.id || statusEvent?.wamid, 180);
  const altId = safeText(statusEvent?.wamid && statusEvent.wamid !== primaryId ? statusEvent.wamid : null, 180) || null;
  if (!nextStatus || !primaryId) return { ignored: true };

  const current = await client.query(`
    SELECT message.id,message.status,message.contact_id,message.conversation_id,recipient.id AS recipient_id,recipient.campaign_id
    FROM pedidos_app_crm_messages message
    LEFT JOIN pedidos_app_crm_campaign_recipients recipient ON recipient.message_id=message.id OR recipient.provider_message_id=message.provider_message_id
    WHERE message.provider_message_id=$1 OR ($2::text IS NOT NULL AND message.provider_message_id=$2)
    LIMIT 1
  `, [primaryId, altId]);
  if (!current.rows.length) return { ignored: true };
  const row = current.rows[0];
  const effectiveStatus = MESSAGE_RANK[nextStatus] >= (MESSAGE_RANK[row.status] ?? -1) ? nextStatus : row.status;
  const occurredAt = parseMessageTimestamp(statusEvent, fallbackTime);
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
  const topType = String(body?.type || '').trim();
  if (topType === 'whatsapp.message.updated' || topType === 'whatsapp.smb.message.echoes' || topType === 'whatsapp.outbound_message.updated') {
    return 'YCLOUD_MESSAGE_UPDATED';
  }
  if (topType === 'whatsapp.inbound_message.received' || body?.whatsappInboundMessage) {
    return 'YCLOUD_INBOUND_RECEIVED';
  }
  if (body?.whatsappMessage) {
    const dir = String(body.whatsappMessage.direction || '').toLowerCase();
    return dir === 'inbound' ? 'YCLOUD_INBOUND_RECEIVED' : 'YCLOUD_MESSAGE_UPDATED';
  }

  let messages = 0;
  let statuses = 0;
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages' && change.field !== 'smb_message_echoes') continue;
      messages += Array.isArray(change.value?.messages) ? change.value.messages.length : 0;
      messages += Array.isArray(change.value?.message_echoes) ? change.value.message_echoes.length : 0;
      statuses += Array.isArray(change.value?.statuses) ? change.value.statuses.length : 0;
    }
  }
  if (messages && statuses) return 'MESSAGES_AND_STATUSES';
  if (messages) return 'MESSAGES';
  if (statuses) return 'MESSAGE_STATUSES';
  return 'WHATSAPP_EVENT';
}

async function processYCloudMessageUpdated(client, msg, fallbackTime = null) {
  if (!msg || typeof msg !== 'object') return { ignored: true };
  if (String(msg.direction || '').toLowerCase() === 'inbound') {
    return processInboundMessage(
      client,
      { metadata: { phone_number_id: msg.to?.replace(/^whatsapp:/i, '') } },
      msg,
      msg.customerProfile || {},
      fallbackTime
    );
  }

  const providerMessageId = safeText(msg.id || msg.wamid, 180);
  const altMessageId = safeText(msg.wamid && msg.wamid !== providerMessageId ? msg.wamid : null, 180) || null;
  if (!providerMessageId) return { ignored: true };
  const status = String(msg.status || '').toLowerCase();
  const occurredAt = parseMessageTimestamp(msg, fallbackTime);

  const current = await client.query(`
    SELECT message.id,message.status,message.contact_id,message.conversation_id,recipient.id AS recipient_id,recipient.campaign_id
    FROM pedidos_app_crm_messages message
    LEFT JOIN pedidos_app_crm_campaign_recipients recipient ON recipient.message_id=message.id OR recipient.provider_message_id=message.provider_message_id
    WHERE message.provider_message_id=$1 OR ($2::text IS NOT NULL AND message.provider_message_id=$2)
    LIMIT 1
  `, [providerMessageId, altMessageId]);

  if (current.rows.length) {
    const nextStatus = MESSAGE_STATUS[status];
    if (!nextStatus) return { ignored: true };
    return await processMessageStatus(client, {
      id: providerMessageId,
      wamid: altMessageId,
      status,
      timestamp: Math.floor(occurredAt.getTime() / 1000),
      sendTime: msg.sendTime,
      deliverTime: msg.deliverTime,
      readTime: msg.readTime,
      updateTime: msg.updateTime,
      errors: msg.errorCode ? [{ code: msg.errorCode, message: msg.errorMessage }] : undefined,
    }, fallbackTime);
  }

  // Si no existe por provider_message_id, resolvemos el contacto destinatario.
  const rawTo = String(msg.to || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();
  const toPhone = /^\d+$/.test(rawTo) ? rawTo : null;
  const bsuid = msg.toUserId || msg.recipientUserId || (!toPhone && rawTo.length > 4 ? rawTo : null);
  if (!toPhone && !bsuid) return { ignored: true };

  const username = msg.customerProfile?.username || null;
  const profileName = msg.customerProfile?.name || '';
  const contact = await ensureContact(client, { phone: toPhone, bsuid, username, name: profileName, source: 'WHATSAPP', occurredAt });
  const providerAccountId = safeText(String(msg.wabaId || msg.phoneNumberId || msg.from || '').replace(/^whatsapp:/i, ''), 120) || null;
  const conversation = await ensureConversation(client, { contactId: contact.id, providerAccountId, occurredAt });

  // Evitar condición de carrera: si existe un mensaje OUTBOUND en vuelo (QUEUED/SENDING sin provider_message_id)
  // para esta misma conversación en los últimos 10 minutos, vincular este provider_message_id en vez de duplicar fila.
  const inFlight = await client.query(`
    SELECT id FROM pedidos_app_crm_messages
    WHERE conversation_id=$1 AND direction='OUTBOUND' AND provider_message_id IS NULL
      AND status IN ('QUEUED','SENDING') AND created_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
  `, [conversation.id]);

  if (inFlight.rows.length) {
    const inFlightId = inFlight.rows[0].id;
    await client.query(`
      UPDATE pedidos_app_crm_messages SET provider_message_id=$2 WHERE id=$1 AND provider_message_id IS NULL
    `, [inFlightId, providerMessageId]);
    const nextStatus = MESSAGE_STATUS[status] || 'SENT';
    return await processMessageStatus(client, {
      id: providerMessageId,
      wamid: altMessageId,
      status: nextStatus.toLowerCase(),
      timestamp: Math.floor(occurredAt.getTime() / 1000),
      errors: msg.errorCode ? [{ code: msg.errorCode, message: msg.errorMessage }] : undefined,
    }, fallbackTime);
  }

  const rawType = String(msg.type || 'unknown').toLowerCase();
  const type = VALID_INBOUND_MESSAGE_TYPES.has(rawType) ? rawType : 'unknown';
  const textBody = extractMessageText(msg) || (msg.template?.name ? `[Plantilla: ${msg.template.name}]` : '');
  const initialStatus = MESSAGE_STATUS[status] || 'SENT';
  const deliveredAt = ['DELIVERED', 'READ'].includes(initialStatus) ? occurredAt : null;
  const readAt = initialStatus === 'READ' ? occurredAt : null;
  const normalizedContent = { ...publicMessageContent(msg), ...msg };

  const inserted = await client.query(`
    INSERT INTO pedidos_app_crm_messages
      (conversation_id,contact_id,provider_message_id,direction,message_type,text_body,content,status,sent_at,delivered_at,read_at,created_at)
    VALUES ($1,$2,$3,'OUTBOUND',$4,$5,$6::jsonb,$7,$8,$9,$10,$8)
    ON CONFLICT DO NOTHING RETURNING id
  `, [conversation.id, contact.id, providerMessageId, type, textBody, JSON.stringify(normalizedContent), initialStatus, occurredAt, deliveredAt, readAt]);

  if (inserted.rowCount) {
    await client.query(`
      UPDATE pedidos_app_crm_conversations
      SET last_message_at=GREATEST(COALESCE(last_message_at,$2::timestamptz),$2::timestamptz),
          last_outbound_at=GREATEST(COALESCE(last_outbound_at,$2::timestamptz),$2::timestamptz),
          updated_at=NOW()
      WHERE id=$1
    `, [conversation.id, occurredAt]);
    await client.query('SELECT pedidos_app_crm_refresh_contact($1)', [contact.id]);
    await appendCrmEvent(client, 'whatsapp.message.sent', 'crm_conversation', conversation.id, {
      contactId: Number(contact.id),
      conversationId: Number(conversation.id),
      messageId: Number(inserted.rows[0].id),
    });
  }
  return { ignored: false, createdOutbound: true, messageId: inserted.rows[0]?.id || null };
}

async function registerWhatsAppWebhook(pool, body, rawBody) {
  const eventKey = `whatsapp:${hashPayload(rawBody || body)}`;
  const eventType = whatsappWebhookEventType(body);
  const { rows } = await pool.query(`
    INSERT INTO pedidos_app_crm_webhook_events (event_key,event_type,signature_valid,payload)
    VALUES ($1,$2,TRUE,$3::jsonb)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id,event_key,processing_status
  `, [eventKey, eventType, JSON.stringify(body)]);
  return { eventKey, eventType, duplicate: rows.length === 0, eventId: rows[0]?.id || null };
}

async function processStoredWhatsAppWebhook(pool, eventKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT payload, event_type FROM pedidos_app_crm_webhook_events
      WHERE event_key=$1 AND processing_status IN ('RECEIVED','FAILED')
      FOR UPDATE SKIP LOCKED
    `, [eventKey]);
    if (!rows.length) { await client.query('COMMIT'); return { duplicate: true, processed: 0 }; }
    const body = rows[0].payload || {};
    const eventType = rows[0].event_type || whatsappWebhookEventType(body);
    const fallbackTime = body.createTime || body.timestamp || null;
    let processed = 0;

    if (eventType === 'YCLOUD_INBOUND_RECEIVED') {
      const msg = body.whatsappInboundMessage || body.whatsappMessage || body.message || body.data?.whatsappInboundMessage;
      if (msg) {
        const result = await processInboundMessage(
          client,
          { metadata: { phone_number_id: msg.to?.replace(/^whatsapp:/i, '') || msg.wabaId } },
          msg,
          msg.customerProfile || {},
          fallbackTime
        );
        if (!result.duplicate) processed += 1;
      }
    } else if (eventType === 'YCLOUD_MESSAGE_UPDATED') {
      const msg = body.whatsappMessage || body.whatsappOutboundMessage || body.message || body.data?.whatsappMessage;
      if (msg) {
        const result = await processYCloudMessageUpdated(client, msg, fallbackTime);
        if (!result.ignored) processed += 1;
      }
    } else {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages' && change.field !== 'smb_message_echoes') continue;
          const value = change.value || {};
          const profiles = new Map((value.contacts || []).map((profile) => [profile.wa_id, profile]));
          for (const message of value.messages || []) {
            const result = await processInboundMessage(client, value, message, profiles.get(message.from), fallbackTime);
            if (!result.duplicate) processed += 1;
          }
          for (const echo of value.message_echoes || []) {
            const result = await processYCloudMessageUpdated(client, echo, fallbackTime);
            if (!result.ignored) processed += 1;
          }
          for (const statusEvent of value.statuses || []) {
            const result = await processMessageStatus(client, statusEvent, fallbackTime);
            if (!result.ignored) processed += 1;
          }
        }
      }
    }
    await client.query(`
      UPDATE pedidos_app_crm_webhook_events SET processing_status='PROCESSED',processed_at=NOW(),error_code=NULL,error_message=NULL WHERE event_key=$1
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
    logCrmTrace('webhook_processing_error', {
      event_key: eventKey,
      code: error.code || 'WHATSAPP_WEBHOOK_PROCESSING_FAILED',
      message: safeText(error.message, 300),
    }, 'error');
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

async function processPendingWhatsAppWebhooks(pool, limit = 25) {
  const { rows } = await pool.query(`
    SELECT event_key FROM pedidos_app_crm_webhook_events
    WHERE provider='WHATSAPP'
      AND (
        processing_status='RECEIVED'
        OR (processing_status='FAILED' AND (
          error_code IN ('23505','23514','42P08','WHATSAPP_WEBHOOK_PROCESSING_FAILED')
          OR received_at >= NOW() - INTERVAL '7 days'
        ))
      )
    ORDER BY received_at,id LIMIT $1
  `, [Math.max(1, Math.min(200, Number(limit) || 25))]);
  let processedEvents = 0;
  for (const row of rows) {
    try {
      const result = await processStoredWhatsAppWebhook(pool, row.event_key);
      if (!result.duplicate) processedEvents += 1;
    } catch (error) {
      logCrmTrace('webhook_retry_failed', {
        event_key: row.event_key,
        code: error.code || 'WHATSAPP_WEBHOOK_PROCESSING_FAILED',
        message: safeText(error.message, 300),
      }, 'error');
    }
  }
  return processedEvents;
}

async function queueConversationMessage(pool, { conversationId, actorUserId, text = null, template = null, idempotencyKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversationResult = await client.query(`
      SELECT conversation.*,contact.normalized_phone,contact.bsuid,contact.no_contact,contact.marketing_opt_out
      FROM pedidos_app_crm_conversations conversation
      JOIN pedidos_app_crm_contacts contact ON contact.id=conversation.contact_id
      WHERE conversation.id=$1 FOR UPDATE OF conversation
    `, [conversationId]);
    if (!conversationResult.rows.length) throw crmError('CONVERSATION_NOT_FOUND', 'Conversación no encontrada.', 404);
    const conversation = conversationResult.rows[0];
    // sendTo: usar teléfono si existe, sino BSUID (usuario con número oculto)
    const sendTo = conversation.normalized_phone || conversation.bsuid;
    if (!sendTo || sendTo === 'CONSUMIDOR_FINAL') throw crmError('CONTACT_NO_SEND_ADDRESS', 'El contacto no tiene teléfono ni identificador de WhatsApp disponible.', 409);
    if (conversation.no_contact || conversation.marketing_opt_out) throw crmError('CONTACT_OPTED_OUT', 'El contacto solicitó no recibir mensajes.', 409);
    let jobType;
    let messageType;
    let payload;
    let effectiveTextBody = null;
    let contentPayload = {};
    if (template) {
      const templateResult = await client.query(`SELECT * FROM pedidos_app_crm_whatsapp_templates WHERE id=$1`, [template.id]);
      const templateRow = templateResult.rows[0];
      if (!templateRow || templateRow.status !== 'APPROVED') throw crmError('WHATSAPP_TEMPLATE_INVALID', 'La plantilla debe estar aprobada por Meta.', 409);
      const tplBodyText = Array.isArray(templateRow.components)
        ? (templateRow.components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')?.text || null)
        : null;
      jobType = 'TEMPLATE';
      messageType = 'template';
      payload = { to: sendTo, name: templateRow.name, language: templateRow.language, components: template.components || [] };
      effectiveTextBody = safeText(tplBodyText || `[Plantilla: ${templateRow.name}]`, 4096);
      contentPayload = { ...template, templateName: templateRow.name, language: templateRow.language, bodyText: tplBodyText };
    } else {
      const cleanText = safeText(text, 4096);
      if (!cleanText) throw crmError('WHATSAPP_MESSAGE_EMPTY', 'Escribe un mensaje antes de enviarlo.', 400);
      if (!conversation.last_inbound_at || new Date(conversation.last_inbound_at).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
        throw crmError('WHATSAPP_SESSION_EXPIRED', 'La ventana de atención de 24 horas terminó. Usa una plantilla aprobada.', 409);
      }
      jobType = 'TEXT';
      messageType = 'text';
      payload = { to: sendTo, body: cleanText };
      effectiveTextBody = cleanText;
      contentPayload = { text: cleanText };
    }
    const key = safeText(idempotencyKey, 180) || crypto.randomUUID();
    const existing = await client.query(`
      SELECT job.message_id, msg.*
      FROM pedidos_app_crm_message_jobs job
      LEFT JOIN pedidos_app_crm_messages msg ON msg.id = job.message_id
      WHERE job.job_key=$1
    `, [`manual:${actorUserId}:${key}`]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { duplicate: true, messageId: existing.rows[0].message_id, message: existing.rows[0] };
    }
    const messageResult = await client.query(`
      INSERT INTO pedidos_app_crm_messages
        (conversation_id,contact_id,direction,message_type,text_body,content,status,sent_by,queued_at)
      VALUES ($1,$2,'OUTBOUND',$3,$4,$5::jsonb,'QUEUED',$6,NOW()) RETURNING *
    `, [conversation.id, conversation.contact_id, messageType, effectiveTextBody, JSON.stringify(contentPayload), actorUserId]);
    await client.query(`
      INSERT INTO pedidos_app_crm_message_jobs (job_key,message_id,job_type,payload)
      VALUES ($1,$2,$3,$4::jsonb)
    `, [`manual:${actorUserId}:${key}`, messageResult.rows[0].id, jobType, JSON.stringify(payload)]);
    await client.query(`UPDATE pedidos_app_crm_conversations SET last_outbound_at=NOW(),last_message_at=NOW(),updated_at=NOW() WHERE id=$1`, [conversation.id]);
    await client.query(`
      INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,actor_user_id,summary,metadata)
      VALUES ($1,'MESSAGE_QUEUED','CRM_MESSAGE',$2,$3,'Mensaje de WhatsApp en cola',$4::jsonb)
    `, [conversation.contact_id, String(messageResult.rows[0].id), actorUserId, JSON.stringify({ conversationId: conversation.id, type: messageType })]);
    await appendCrmEvent(client, 'whatsapp.message.queued', 'crm_conversation', conversation.id, {
      contactId: Number(conversation.contact_id),
      conversationId: Number(conversation.id),
      messageId: Number(messageResult.rows[0].id),
    });
    await client.query('COMMIT');
    return { duplicate: false, messageId: messageResult.rows[0].id, message: messageResult.rows[0] };
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
    const providerMessageId = response.id || response.wamid || response.messages?.[0]?.id;
    if (!providerMessageId) throw crmError('WHATSAPP_SEND_FAILED', 'El proveedor no devolvió el identificador del mensaje.', 502);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Si un webhook echo llegó antes de que completeJob terminara y creó una fila duplicada con el mismo provider_message_id,
      // absorbemos su estado y liberamos la fila duplicada para evitar violación de unicidad 23505.
      const earlyEcho = await client.query(`
        DELETE FROM pedidos_app_crm_messages
        WHERE provider_message_id=$1 AND id<>$2
        RETURNING status,sent_at,delivered_at,read_at
      `, [providerMessageId, job.message_id]);
      const echoRow = earlyEcho.rows[0] || null;
      const targetStatus = echoRow && ['DELIVERED', 'READ'].includes(echoRow.status) ? echoRow.status : 'SENT';

      const message = await client.query(`
        UPDATE pedidos_app_crm_messages
        SET provider_message_id=$2,
            status=CASE WHEN status IN ('DELIVERED','READ') THEN status ELSE $3::varchar END,
            sent_at=COALESCE(sent_at,$4::timestamptz,NOW()),
            delivered_at=COALESCE(delivered_at,$5::timestamptz),
            read_at=COALESCE(read_at,$6::timestamptz),
            error_code=NULL,
            error_message=NULL
        WHERE id=$1
        RETURNING conversation_id,contact_id,status
      `, [job.message_id, providerMessageId, targetStatus, echoRow?.sent_at || null, echoRow?.delivered_at || null, echoRow?.read_at || null]);
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
      UPDATE pedidos_app_crm_message_jobs SET status=$2::varchar,available_at=CASE WHEN $2::varchar='RETRY' THEN NOW()+($3*INTERVAL '1 second') ELSE available_at END,
        locked_at=NULL,locked_by=NULL,last_error_code=$4,last_error_message=$5,updated_at=NOW() WHERE id=$1
    `, [job.id, status, delaySeconds, safeText(error.code || 'WHATSAPP_SEND_FAILED', 80), safeText(error.message, 500)]);
    let msgRow = null;
    if (job.message_id) {
      const msgRes = await pool.query(`
        UPDATE pedidos_app_crm_messages SET status=$2::varchar,error_code=$3,error_message=$4,
          failed_at=CASE WHEN $2::varchar='FAILED' THEN NOW() ELSE failed_at END
        WHERE id=$1 RETURNING id,conversation_id,contact_id,status
      `, [job.message_id, finalFailure ? 'FAILED' : 'QUEUED', safeText(error.code, 80), safeText(error.message, 500)]);
      msgRow = msgRes.rows[0] || null;
    }
    let campaignId = null;
    if (job.campaign_recipient_id) {
      const recipient = await pool.query(`
        UPDATE pedidos_app_crm_campaign_recipients SET status=$2::varchar,failed_at=CASE WHEN $2::varchar='FAILED' THEN NOW() ELSE failed_at END,updated_at=NOW()
        WHERE id=$1 RETURNING campaign_id
      `, [job.campaign_recipient_id, finalFailure ? 'FAILED' : 'QUEUED']);
      campaignId = recipient.rows[0]?.campaign_id;
      if (campaignId) await pool.query('SELECT pedidos_app_crm_refresh_campaign($1)', [campaignId]);
    }
    await pool.query(`UPDATE pedidos_app_crm_provider_state SET last_error_code=$1,last_error_at=NOW(),updated_at=NOW() WHERE provider='WHATSAPP'`, [safeText(error.code || 'WHATSAPP_SEND_FAILED', 80)]);
    if (msgRow && finalFailure) {
      await appendCrmEvent(pool, 'whatsapp.message.status', 'crm_conversation', msgRow.conversation_id, {
        contactId: Number(msgRow.contact_id),
        conversationId: Number(msgRow.conversation_id),
        messageId: Number(msgRow.id),
        status: 'FAILED',
      }).catch(() => {});
    }
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
          template.name AS template_name,template.language AS template_language,template.components AS template_components,
          contact.normalized_phone,contact.bsuid,contact.id AS contact_id
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
        const tplBodyText = Array.isArray(recipient.template_components)
          ? (recipient.template_components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')?.text || null)
          : null;
        const templateText = safeText(tplBodyText || `[Plantilla: ${recipient.template_name}]`, 4096);
        const message = await client.query(`
          INSERT INTO pedidos_app_crm_messages
            (conversation_id,contact_id,direction,message_type,text_body,content,status,queued_at)
          VALUES ($1,$2,'OUTBOUND','template',$3,$4::jsonb,'QUEUED',NOW()) RETURNING id
        `, [conversation.id, recipient.contact_id, templateText, JSON.stringify({ template: recipient.template_name, language: recipient.template_language, bodyText: tplBodyText, components })]);
        await client.query(`
          UPDATE pedidos_app_crm_campaign_recipients SET message_id=$2,status='QUEUED',queued_at=NOW(),updated_at=NOW() WHERE id=$1
        `, [recipient.id, message.rows[0].id]);
        await client.query(`
          INSERT INTO pedidos_app_crm_message_jobs
            (job_key,message_id,campaign_recipient_id,job_type,payload,priority)
          VALUES ($1,$2,$3,'TEMPLATE',$4::jsonb,40)
          ON CONFLICT (job_key) DO NOTHING
        `, [`campaign:${recipient.campaign_id}:${recipient.contact_id}`, message.rows[0].id, recipient.id,
          JSON.stringify({ to: recipient.normalized_phone || recipient.bsuid, name: recipient.template_name, language: recipient.template_language, components })]);
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
    try {
      await pool.query('SELECT pedidos_app_crm_refresh_contact($1::bigint)', [rows[0].crm_contact_id]);
    } catch {}
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
  maskIdentifier,
  processPendingWhatsAppWebhooks,
  processStoredWhatsAppWebhook,
  processWhatsAppWebhook,
  registerWhatsAppWebhook,
  queueConversationMessage,
  scheduleEventAutomations,
  // Funciones internas expuestas solo para pruebas unitarias
  __test__: {
    ensureContact,
    ensureConversation,
    extractMessageText,
    maskIdentifier,
    parseMessageTimestamp,
    processInboundMessage,
    processMessageStatus,
    processYCloudMessageUpdated,
    publicMessageContent,
    whatsappWebhookEventType,
  },
};
