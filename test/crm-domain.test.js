const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { normalizePhoneE164, whatsappRecipient, maskPhone } = require('../src/crm/phone');
const { classifyCrmContact } = require('../src/crm/classification');
const { compileSegment, validateSegmentDefinition } = require('../src/crm/segments');
const { configuration, validateWebhookSignature, describeWebhookSignature } = require('../src/whatsapp-cloud');
const {
  buildCampaignTemplateComponents,
  createCrmWorker,
  processPendingWhatsAppWebhooks,
  processStoredWhatsAppWebhook,
  processWhatsAppWebhook,
  queueConversationMessage,
  registerWhatsAppWebhook,
  __test__,
} = require('../src/crm-service');
const registerCrmApi = require('../crm_api');

process.env.CRM_SILENT_LOGS = 'true';

/**
 * Base de datos relacional en memoria aislada para pruebas integrales del pipeline CRM.
 * No realiza conexiones externas ni modifica ninguna base de datos real.
 */
function createInMemoryCrmPool() {
  const state = {
    seq: {
      contacts: 1,
      conversations: 1,
      messages: 1,
      webhooks: 1,
      jobs: 1,
      activities: 1,
      events: 1,
      templates: 1,
      orders: 1,
      notes: 1,
    },
    contacts: [],
    conversations: [],
    messages: [],
    webhooks: [],
    jobs: [],
    activities: [],
    domainEvents: [],
    templates: [
      {
        id: 1,
        name: 'reactivacion_distrito',
        language: 'es_CO',
        category: 'MARKETING',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Hola {{1}}, tenemos nuevas burgers esperándote en Distrito BG.' }],
      },
    ],
    orders: [],
    notes: [],
    providerState: {
      provider: 'WHATSAPP',
      configured: true,
      webhook_connected: false,
      number_connected: false,
      last_webhook_at: null,
      last_inbound_at: null,
      last_outbound_at: null,
      last_error_code: null,
    },
    failNextInboundInsert: false,
  };

  let snapshot = null;

  function cloneState() {
    return JSON.parse(
      JSON.stringify({
        seq: state.seq,
        contacts: state.contacts,
        conversations: state.conversations,
        messages: state.messages,
        webhooks: state.webhooks,
        jobs: state.jobs,
        activities: state.activities,
        domainEvents: state.domainEvents,
        templates: state.templates,
        orders: state.orders,
        notes: state.notes,
        providerState: state.providerState,
      })
    );
  }

  function restoreState(snap) {
    if (!snap) return;
    Object.assign(state.seq, snap.seq);
    state.contacts = snap.contacts;
    state.conversations = snap.conversations;
    state.messages = snap.messages;
    state.webhooks = snap.webhooks;
    state.jobs = snap.jobs;
    state.activities = snap.activities;
    state.domainEvents = snap.domainEvents;
    state.templates = snap.templates;
    state.orders = snap.orders;
    state.notes = snap.notes;
    state.providerState = snap.providerState;
  }

  async function query(rawSql, params = []) {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN') {
      snapshot = cloneState();
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      restoreState(snapshot);
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ') || sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT pedidos_app_crm_refresh_contact') || sql.startsWith('SELECT pedidos_app_crm_refresh_campaign')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO pedidos_app_crm_automation_runs')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO pedidos_app_crm_contact_customers')) {
      return { rows: [], rowCount: 0 };
    }

    // 1. Webhook Events
    if (sql.startsWith('INSERT INTO pedidos_app_crm_webhook_events')) {
      const [eventKey, eventType, payloadJson] = params;
      const existing = state.webhooks.find((w) => w.event_key === eventKey);
      if (existing) return { rows: [], rowCount: 0 };
      const row = {
        id: state.seq.webhooks++,
        provider: 'WHATSAPP',
        event_key: eventKey,
        event_type: eventType,
        signature_valid: true,
        processing_status: 'RECEIVED',
        payload: JSON.parse(payloadJson),
        received_at: new Date().toISOString(),
        processed_at: null,
        error_code: null,
        error_message: null,
      };
      state.webhooks.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('FROM pedidos_app_crm_webhook_events WHERE event_key=$1 AND processing_status IN')) {
      const [eventKey] = params;
      const row = state.webhooks.find(
        (w) => w.event_key === eventKey && ['RECEIVED', 'FAILED'].includes(w.processing_status)
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('SELECT event_key FROM pedidos_app_crm_webhook_events WHERE provider=\'WHATSAPP\'')) {
      const limit = Number(params[0]) || 25;
      const rows = state.webhooks
        .filter((w) => w.processing_status === 'RECEIVED' || w.processing_status === 'FAILED')
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_webhook_events SET processing_status=\'PROCESSED\'')) {
      const [eventKey] = params;
      const row = state.webhooks.find((w) => w.event_key === eventKey);
      if (row) {
        row.processing_status = 'PROCESSED';
        row.processed_at = new Date().toISOString();
        row.error_code = null;
        row.error_message = null;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_webhook_events SET processing_status=\'FAILED\'')) {
      const [eventKey, errorCode, errorMessage] = params;
      const row = state.webhooks.find((w) => w.event_key === eventKey);
      if (row) {
        row.processing_status = 'FAILED';
        row.error_code = errorCode;
        row.error_message = errorMessage;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // 2. Contacts
    if (sql.startsWith('SELECT * FROM pedidos_app_crm_contacts WHERE bsuid=$1')) {
      const row = state.contacts.find((c) => c.bsuid === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM pedidos_app_crm_contacts WHERE normalized_phone=$1')) {
      const row = state.contacts.find((c) => c.normalized_phone === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM pedidos_app_crm_contacts WHERE id IN ($1,$2)')) {
      const rows = state.contacts
        .filter((c) => Number(c.id) === Number(params[0]) || Number(c.id) === Number(params[1]))
        .sort((a, b) => a.id - b.id);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT * FROM pedidos_app_crm_contacts WHERE id=$1')) {
      const row = state.contacts.find((c) => Number(c.id) === Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT id FROM pedidos_app_crm_contacts WHERE id=$1 AND deleted_at IS NULL')) {
      const row = state.contacts.find((c) => Number(c.id) === Number(params[0]) && !c.deleted_at);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET normalized_phone=NULL,bsuid=$2,deleted_at=NOW()')) {
      const [dropId, mergedBsuid] = params;
      const row = state.contacts.find((c) => Number(c.id) === Number(dropId));
      if (row) {
        row.normalized_phone = null;
        row.bsuid = mergedBsuid;
        row.deleted_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET normalized_phone=COALESCE(normalized_phone,$2), bsuid=COALESCE(bsuid,$3)')) {
      const [keepId, phone, bsuid, username, displayName, email, address, barrio] = params;
      const row = state.contacts.find((c) => Number(c.id) === Number(keepId));
      if (row) {
        row.normalized_phone = row.normalized_phone || phone;
        row.bsuid = row.bsuid || bsuid;
        row.username = row.username || username;
        row.display_name = row.display_name || displayName;
        row.email = row.email || email;
        row.address = row.address || address;
        row.barrio = row.barrio || barrio;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET normalized_phone=COALESCE(normalized_phone,$2), display_name=')) {
      const [id, phone, name, username, contactTime] = params;
      const row = state.contacts.find((c) => Number(c.id) === Number(id));
      if (row) {
        row.normalized_phone = row.normalized_phone || phone;
        row.display_name = name || row.display_name;
        row.username = username || row.username;
        row.marketing_opt_in = true;
        if (!String(row.bsuid || '').startsWith('MERGED:')) row.deleted_at = null;
        const iso = new Date(contactTime).toISOString();
        if (!row.first_contact_at || iso < row.first_contact_at) row.first_contact_at = iso;
        if (!row.last_contact_at || iso > row.last_contact_at) row.last_contact_at = iso;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET bsuid=COALESCE(bsuid,$2), display_name=')) {
      const [id, bsuid, name, username, contactTime] = params;
      const row = state.contacts.find((c) => Number(c.id) === Number(id));
      if (row) {
        row.bsuid = row.bsuid || bsuid;
        row.display_name = name || row.display_name;
        row.username = username || row.username;
        row.marketing_opt_in = true;
        if (!String(row.bsuid || '').startsWith('MERGED:')) row.deleted_at = null;
        const iso = new Date(contactTime).toISOString();
        if (!row.first_contact_at || iso < row.first_contact_at) row.first_contact_at = iso;
        if (!row.last_contact_at || iso > row.last_contact_at) row.last_contact_at = iso;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_crm_contacts (normalized_phone,bsuid,username')) {
      const [normalizedPhone, bsuid, username, displayName, email, address, barrio, source, contactTime] = params;
      const iso = new Date(contactTime).toISOString();
      const row = {
        id: state.seq.contacts++,
        normalized_phone: normalizedPhone,
        bsuid,
        username,
        display_name: displayName,
        email,
        address,
        barrio,
        source,
        status: 'PROSPECTO',
        orders_count: 0,
        total_spent: 0,
        average_ticket: 0,
        marketing_opt_in: true,
        marketing_opt_out: false,
        no_contact: false,
        first_contact_at: iso,
        last_contact_at: iso,
        deleted_at: null,
      };
      state.contacts.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_crm_contacts (normalized_phone,display_name')) {
      const [normalizedPhone, displayName, email, address, barrio, source, contactTime] = params;
      const iso = new Date(contactTime).toISOString();
      let row = state.contacts.find((c) => c.normalized_phone === normalizedPhone);
      if (row) {
        row.display_name = displayName || row.display_name;
        row.email = email || row.email;
        row.address = address || row.address;
        row.barrio = barrio || row.barrio;
        row.marketing_opt_in = true;
        if (!String(row.bsuid || '').startsWith('MERGED:')) row.deleted_at = null;
        if (!row.first_contact_at || iso < row.first_contact_at) row.first_contact_at = iso;
        if (!row.last_contact_at || iso > row.last_contact_at) row.last_contact_at = iso;
      } else {
        row = {
          id: state.seq.contacts++,
          normalized_phone: normalizedPhone,
          bsuid: null,
          username: null,
          display_name: displayName,
          email,
          address,
          barrio,
          source,
          status: 'PROSPECTO',
          orders_count: 0,
          total_spent: 0,
          average_ticket: 0,
          marketing_opt_in: true,
          marketing_opt_out: false,
          no_contact: false,
          first_contact_at: iso,
          last_contact_at: iso,
          deleted_at: null,
        };
        state.contacts.push(row);
      }
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET first_contact_at=')) {
      const [id, occurredAt] = params;
      const row = state.contacts.find((c) => Number(c.id) === Number(id));
      if (row) {
        const iso = new Date(occurredAt).toISOString();
        if (!row.first_contact_at || iso < row.first_contact_at) row.first_contact_at = iso;
        if (!row.last_contact_at || iso > row.last_contact_at) row.last_contact_at = iso;
        if (!String(row.bsuid || '').startsWith('MERGED:')) row.deleted_at = null;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // 3. Conversations
    if (sql.startsWith('INSERT INTO pedidos_app_crm_conversations')) {
      const [contactId, providerAccountId, assignedUserId, initialTime] = params;
      const existingActive = state.conversations.find(
        (c) => Number(c.contact_id) === Number(contactId) && c.channel === 'WHATSAPP' && ['OPEN', 'PENDING'].includes(c.status)
      );
      if (existingActive) return { rows: [], rowCount: 0 };
      const iso = new Date(initialTime || Date.now()).toISOString();
      const row = {
        id: state.seq.conversations++,
        contact_id: Number(contactId),
        channel: 'WHATSAPP',
        provider_account_id: providerAccountId,
        status: 'OPEN',
        assigned_user_id: assignedUserId,
        unread_count: 0,
        first_message_at: iso,
        last_message_at: iso,
        last_inbound_at: null,
        last_outbound_at: null,
        closed_at: null,
        created_at: iso,
        updated_at: iso,
      };
      state.conversations.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET provider_account_id=COALESCE')) {
      const [contactId, providerAccountId, assignedUserId] = params;
      const row = state.conversations.find(
        (c) => Number(c.contact_id) === Number(contactId) && c.channel === 'WHATSAPP' && ['OPEN', 'PENDING'].includes(c.status)
      );
      if (row) {
        row.provider_account_id = providerAccountId || row.provider_account_id;
        row.assigned_user_id = row.assigned_user_id || assignedUserId;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT id FROM pedidos_app_crm_conversations WHERE contact_id=$1 AND channel=\'WHATSAPP\'')) {
      const row = state.conversations.find(
        (c) => Number(c.contact_id) === Number(params[0]) && c.channel === 'WHATSAPP' && ['OPEN', 'PENDING'].includes(c.status)
      );
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM pedidos_app_crm_conversations WHERE contact_id=$1 ORDER BY id')) {
      const rows = state.conversations.filter((c) => Number(c.contact_id) === Number(params[0]));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET unread_count=unread_count+$2')) {
      const [activeId, addUnread, firstMsg, lastMsg, lastIn, lastOut] = params;
      const row = state.conversations.find((c) => Number(c.id) === Number(activeId));
      if (row) {
        row.unread_count = (Number(row.unread_count) || 0) + (Number(addUnread) || 0);
        if (firstMsg && (!row.first_message_at || firstMsg < row.first_message_at)) row.first_message_at = firstMsg;
        if (lastMsg && (!row.last_message_at || lastMsg > row.last_message_at)) row.last_message_at = lastMsg;
        if (lastIn && (!row.last_inbound_at || lastIn > row.last_inbound_at)) row.last_inbound_at = lastIn;
        if (lastOut && (!row.last_outbound_at || lastOut > row.last_outbound_at)) row.last_outbound_at = lastOut;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM pedidos_app_crm_conversations WHERE id=$1')) {
      const idx = state.conversations.findIndex((c) => Number(c.id) === Number(params[0]));
      if (idx >= 0) state.conversations.splice(idx, 1);
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET unread_count=unread_count+1')) {
      const [convId, occurredAt] = params;
      const row = state.conversations.find((c) => Number(c.id) === Number(convId));
      if (row) {
        const iso = new Date(occurredAt).toISOString();
        row.unread_count = (Number(row.unread_count) || 0) + 1;
        if (!row.first_message_at || iso < row.first_message_at) row.first_message_at = iso;
        if (!row.last_message_at || iso > row.last_message_at) row.last_message_at = iso;
        if (!row.last_inbound_at || iso > row.last_inbound_at) row.last_inbound_at = iso;
        row.status = 'OPEN';
        row.closed_at = null;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET last_message_at=GREATEST')) {
      const [convId, occurredAt] = params;
      const row = state.conversations.find((c) => Number(c.id) === Number(convId));
      if (row) {
        const iso = new Date(occurredAt).toISOString();
        if (!row.last_message_at || iso > row.last_message_at) row.last_message_at = iso;
        if (!row.last_outbound_at || iso > row.last_outbound_at) row.last_outbound_at = iso;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET last_outbound_at=NOW()')) {
      const [convId] = params;
      const row = state.conversations.find((c) => Number(c.id) === Number(convId));
      if (row) {
        const iso = new Date().toISOString();
        row.last_outbound_at = iso;
        row.last_message_at = iso;
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_conversations SET unread_count=0')) {
      const [convId] = params;
      const row = state.conversations.find((c) => Number(c.id) === Number(convId));
      if (row) row.unread_count = 0;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM pedidos_app_crm_conversations conversation JOIN pedidos_app_crm_contacts contact ON contact.id=conversation.contact_id WHERE conversation.id=$1 FOR UPDATE')) {
      const conv = state.conversations.find((c) => Number(c.id) === Number(params[0]));
      if (!conv) return { rows: [], rowCount: 0 };
      const contact = state.contacts.find((c) => Number(c.id) === Number(conv.contact_id));
      if (!contact) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ...conv,
            normalized_phone: contact.normalized_phone,
            bsuid: contact.bsuid,
            no_contact: contact.no_contact,
            marketing_opt_out: contact.marketing_opt_out,
          },
        ],
        rowCount: 1,
      };
    }

    // 4. Messages
    if (sql.startsWith('INSERT INTO pedidos_app_crm_messages') && sql.includes("'INBOUND'")) {
      if (state.failNextInboundInsert) {
        state.failNextInboundInsert = false;
        const err = new Error('Simulated transient DB connection failure');
        err.code = 'WHATSAPP_WEBHOOK_PROCESSING_FAILED';
        throw err;
      }
      const [convId, contactId, providerMessageId, contextId, type, textBody, contentJson, occurredAt] = params;
      if (providerMessageId && state.messages.some((m) => m.provider_message_id === providerMessageId)) {
        return { rows: [], rowCount: 0 };
      }
      const iso = new Date(occurredAt).toISOString();
      const row = {
        id: state.seq.messages++,
        conversation_id: Number(convId),
        contact_id: Number(contactId),
        provider_message_id: providerMessageId,
        context_provider_message_id: contextId,
        direction: 'INBOUND',
        message_type: type,
        text_body: textBody,
        content: JSON.parse(contentJson || '{}'),
        status: 'RECEIVED',
        sent_by: null,
        received_at: iso,
        created_at: iso,
      };
      state.messages.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_crm_messages') && sql.includes("'QUEUED'")) {
      const [convId, contactId, messageType, textBody, contentJson, actorUserId] = params;
      const iso = new Date().toISOString();
      const row = {
        id: state.seq.messages++,
        conversation_id: Number(convId),
        contact_id: Number(contactId),
        provider_message_id: null,
        direction: 'OUTBOUND',
        message_type: messageType,
        text_body: textBody,
        content: JSON.parse(contentJson || '{}'),
        status: 'QUEUED',
        sent_by: actorUserId || null,
        queued_at: iso,
        created_at: iso,
      };
      state.messages.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_crm_messages') && sql.includes("'OUTBOUND'") && !sql.includes("'QUEUED'")) {
      const [convId, contactId, providerMessageId, type, textBody, contentJson, initialStatus, occurredAt, deliveredAt, readAt] = params;
      if (providerMessageId && state.messages.some((m) => m.provider_message_id === providerMessageId)) {
        return { rows: [], rowCount: 0 };
      }
      const iso = new Date(occurredAt).toISOString();
      const row = {
        id: state.seq.messages++,
        conversation_id: Number(convId),
        contact_id: Number(contactId),
        provider_message_id: providerMessageId,
        direction: 'OUTBOUND',
        message_type: type,
        text_body: textBody,
        content: JSON.parse(contentJson || '{}'),
        status: initialStatus,
        sent_by: null,
        sent_at: iso,
        delivered_at: deliveredAt ? new Date(deliveredAt).toISOString() : null,
        read_at: readAt ? new Date(readAt).toISOString() : null,
        created_at: iso,
      };
      state.messages.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id FROM pedidos_app_crm_messages WHERE conversation_id=$1 AND direction=\'OUTBOUND\' AND provider_message_id IS NULL')) {
      const [convId] = params;
      const row = state.messages.find(
        (m) => Number(m.conversation_id) === Number(convId) && m.direction === 'OUTBOUND' && !m.provider_message_id && ['QUEUED', 'SENDING'].includes(m.status)
      );
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET provider_message_id=$2 WHERE id=$1')) {
      const [id, providerMessageId] = params;
      const row = state.messages.find((m) => Number(m.id) === Number(id) && !m.provider_message_id);
      if (row) row.provider_message_id = providerMessageId;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('SELECT message.id,message.status,message.contact_id,message.conversation_id')) {
      const [primaryId, altId] = params;
      const row = state.messages.find(
        (m) =>
          m.provider_message_id === primaryId ||
          (altId && m.provider_message_id === altId) ||
          m.content?.wamid === primaryId ||
          (altId && m.content?.wamid === altId)
      );
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: row.id,
            status: row.status,
            contact_id: row.contact_id,
            conversation_id: row.conversation_id,
            recipient_id: null,
            campaign_id: null,
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET status=$2::varchar, sent_at=CASE')) {
      const [id, effectiveStatus, occurredAt, errCode, errMsg] = params;
      const row = state.messages.find((m) => Number(m.id) === Number(id));
      if (row) {
        const iso = new Date(occurredAt).toISOString();
        row.status = effectiveStatus;
        if (['SENT', 'DELIVERED', 'READ'].includes(effectiveStatus)) row.sent_at = row.sent_at || iso;
        if (['DELIVERED', 'READ'].includes(effectiveStatus)) row.delivered_at = row.delivered_at || iso;
        if (effectiveStatus === 'READ') row.read_at = row.read_at || iso;
        if (effectiveStatus === 'FAILED') {
          row.failed_at = row.failed_at || iso;
          row.error_code = errCode;
          row.error_message = errMsg;
        }
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM pedidos_app_crm_messages WHERE provider_message_id=$1 AND id<>$2')) {
      const [providerMessageId, keepId] = params;
      const idx = state.messages.findIndex(
        (m) => m.provider_message_id === providerMessageId && Number(m.id) !== Number(keepId)
      );
      if (idx >= 0) {
        const [removed] = state.messages.splice(idx, 1);
        return { rows: [removed], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET provider_message_id=$2,')) {
      const [id, providerMessageId, targetStatus, sentAt, deliveredAt, readAt] = params;
      const dup = state.messages.find((m) => m.provider_message_id === providerMessageId && Number(m.id) !== Number(id));
      if (dup) {
        const err = new Error('duplicate key value violates unique constraint "idx_crm_messages_provider_id"');
        err.code = '23505';
        throw err;
      }
      const row = state.messages.find((m) => Number(m.id) === Number(id));
      if (row) {
        row.provider_message_id = providerMessageId;
        if (!['DELIVERED', 'READ'].includes(row.status)) {
          row.status = targetStatus || 'SENT';
        }
        row.sent_at = row.sent_at || sentAt || new Date().toISOString();
        row.delivered_at = row.delivered_at || deliveredAt || null;
        row.read_at = row.read_at || readAt || null;
      }
      return {
        rows: row ? [{ conversation_id: row.conversation_id, contact_id: row.contact_id, status: row.status }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET conversation_id=$1,contact_id=$2 WHERE conversation_id=$3')) {
      const [activeId, keepNumber, oldConvId] = params;
      state.messages.forEach((m) => {
        if (Number(m.conversation_id) === Number(oldConvId)) {
          m.conversation_id = Number(activeId);
          m.contact_id = Number(keepNumber);
        }
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET contact_id=$1 WHERE contact_id=$2')) {
      const [keepNumber, dropNumber] = params;
      state.messages.forEach((m) => {
        if (Number(m.contact_id) === Number(dropNumber)) m.contact_id = Number(keepNumber);
      });
      return { rows: [], rowCount: 1 };
    }

    // 5. Templates & Jobs
    if (sql.startsWith('SELECT * FROM pedidos_app_crm_whatsapp_templates WHERE id=$1')) {
      const row = state.templates.find((t) => Number(t.id) === Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM pedidos_app_crm_message_jobs job LEFT JOIN pedidos_app_crm_messages msg')) {
      const [jobKey] = params;
      const job = state.jobs.find((j) => j.job_key === jobKey);
      if (!job) return { rows: [], rowCount: 0 };
      const msg = state.messages.find((m) => Number(m.id) === Number(job.message_id)) || {};
      return { rows: [{ message_id: job.message_id, ...msg }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_crm_message_jobs')) {
      const [jobKey, messageId, jobType, payloadJson] = params;
      const row = {
        id: state.seq.jobs++,
        job_key: jobKey,
        message_id: Number(messageId),
        campaign_recipient_id: null,
        job_type: jobType,
        payload: JSON.parse(payloadJson || '{}'),
        status: 'PENDING',
        priority: 100,
        attempts: 0,
        max_attempts: 5,
        available_at: new Date().toISOString(),
      };
      state.jobs.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT job.* FROM pedidos_app_crm_message_jobs job WHERE job.status IN')) {
      const job = state.jobs.find((j) => ['PENDING', 'RETRY'].includes(j.status));
      return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_message_jobs SET status=\'PROCESSING\'')) {
      const [id, instanceId] = params;
      const job = state.jobs.find((j) => Number(j.id) === Number(id));
      if (job) {
        job.status = 'PROCESSING';
        job.attempts += 1;
        job.locked_by = instanceId;
      }
      return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_messages SET status=\'SENDING\'')) {
      const [id] = params;
      const msg = state.messages.find((m) => Number(m.id) === Number(id));
      if (msg && msg.status === 'QUEUED') msg.status = 'SENDING';
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_campaign_recipients SET status=\'SENDING\'')) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_message_jobs SET status=\'COMPLETED\'')) {
      const [id] = params;
      const job = state.jobs.find((j) => Number(j.id) === Number(id));
      if (job) job.status = 'COMPLETED';
      return { rows: [], rowCount: 1 };
    }

    // 6. Activities, Domain Events & Provider State
    if (sql.startsWith('INSERT INTO pedidos_app_crm_activities')) {
      state.activities.push({ id: state.seq.activities++, params });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO pedidos_app_domain_events')) {
      const [eventId, aggregateType, aggregateId, eventType, payloadJson] = params;
      const ev = {
        id: state.seq.events++,
        event_id: eventId,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        payload: JSON.parse(payloadJson || '{}'),
      };
      state.domainEvents.push(ev);
      return { rows: [ev], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_provider_state')) {
      state.providerState.webhook_connected = true;
      state.providerState.last_webhook_at = new Date().toISOString();
      if (params[0] instanceof Date) {
        const iso = params[0].toISOString();
        if (!state.providerState.last_inbound_at || iso > state.providerState.last_inbound_at) {
          state.providerState.last_inbound_at = iso;
        }
      }
      return { rows: [state.providerState], rowCount: 1 };
    }

    // 7. API Endpoints: GET /conversations & GET /conversations/:id
    if (sql.includes('FROM pedidos_app_crm_conversations conversation') && sql.includes('COUNT(*) OVER()::int AS filtered_count')) {
      const [statusFilter, searchLike, limit, offset, unreadOnly, contactIdFilter, chatsOnly] = params;
      const term = String(searchLike || '').replace(/^%|%$/g, '').toLowerCase();

      let rows = state.conversations
        .map((conv) => {
          const contact = state.contacts.find((c) => Number(c.id) === Number(conv.contact_id));
          if (!contact || contact.deleted_at) return null;
          const convMsgs = state.messages
            .filter((m) => Number(m.conversation_id) === Number(conv.id))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id);
          const lastMsg = convMsgs[0] || null;
          const effectiveLastMessageAt = lastMsg?.created_at || conv.last_inbound_at || conv.last_message_at;
          return {
            ...conv,
            display_name: contact.display_name,
            normalized_phone: contact.normalized_phone,
            bsuid: contact.bsuid,
            username: contact.username,
            contact_status: contact.status,
            orders_count: contact.orders_count || 0,
            total_spent: contact.total_spent || 0,
            last_message_id: lastMsg?.id || null,
            last_message_text: lastMsg?.text_body || null,
            last_message_type: lastMsg?.message_type || null,
            last_message_direction: lastMsg?.direction || null,
            last_message_status: lastMsg?.status || null,
            last_message_sent_by: lastMsg?.sent_by || null,
            last_message_created_at: lastMsg?.created_at || null,
            effective_last_message_at: effectiveLastMessageAt,
          };
        })
        .filter(Boolean);

      if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
      if (unreadOnly) rows = rows.filter((r) => r.unread_count > 0);
      if (contactIdFilter) rows = rows.filter((r) => Number(r.contact_id) === Number(contactIdFilter));
      if (chatsOnly) {
        rows = rows.filter((r) => Boolean(r.last_inbound_at) || r.unread_count > 0 || r.last_message_sent_by !== null);
      }
      if (term) {
        rows = rows.filter(
          (r) =>
            String(r.display_name || '').toLowerCase().includes(term) ||
            String(r.normalized_phone || '').toLowerCase().includes(term) ||
            String(r.bsuid || '').toLowerCase().includes(term) ||
            String(r.last_message_text || '').toLowerCase().includes(term)
        );
      }

      rows.sort((a, b) => {
        const tierA = a.last_inbound_at || a.unread_count > 0 || a.last_message_sent_by !== null || a.last_message_id === null ? 0 : 1;
        const tierB = b.last_inbound_at || b.unread_count > 0 || b.last_message_sent_by !== null || b.last_message_id === null ? 0 : 1;
        if (tierA !== tierB) return tierA - tierB;
        return new Date(b.effective_last_message_at || 0) - new Date(a.effective_last_message_at || 0) || b.id - a.id;
      });

      const total = rows.length;
      const paged = rows.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 60)).map((r) => ({
        ...r,
        filtered_count: total,
      }));
      return { rows: paged, rowCount: paged.length };
    }

    if (sql.includes('FROM pedidos_app_crm_conversations conversation') && sql.includes('WHERE conversation.id=$1')) {
      const conv = state.conversations.find((c) => Number(c.id) === Number(params[0]));
      if (!conv) return { rows: [], rowCount: 0 };
      const contact = state.contacts.find((c) => Number(c.id) === Number(conv.contact_id));
      if (!contact) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ...conv,
            display_name: contact.display_name,
            normalized_phone: contact.normalized_phone,
            bsuid: contact.bsuid,
            username: contact.username,
            contact_status: contact.status,
            orders_count: contact.orders_count || 0,
            total_spent: contact.total_spent || 0,
            average_ticket: contact.average_ticket || 0,
            contact_tags: [],
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('SELECT * FROM pedidos_app_crm_messages WHERE conversation_id=$1')) {
      const [convId, beforeId, afterId] = params;
      let msgs = state.messages.filter((m) => Number(m.conversation_id) === Number(convId));
      if (beforeId) msgs = msgs.filter((m) => Number(m.id) < Number(beforeId));
      if (afterId) msgs = msgs.filter((m) => Number(m.id) > Number(afterId));
      msgs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id);
      return { rows: msgs.slice(0, 100), rowCount: msgs.length };
    }

    if (sql.includes('FROM pedidos_app_orders WHERE crm_contact_id=$1')) {
      const rows = state.orders.filter((o) => Number(o.crm_contact_id) === Number(params[0]));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM pedidos_app_crm_notes note')) {
      const rows = state.notes.filter((n) => Number(n.contact_id) === Number(params[0]));
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    state,
    query,
    connect: async () => ({
      query,
      release: () => {},
    }),
  };
}

test('normaliza variantes colombianas a una sola identidad E.164', () => {
  assert.equal(normalizePhoneE164('300 123 4567'), '+573001234567');
  assert.equal(normalizePhoneE164('57 300 123 4567'), '+573001234567');
  assert.equal(normalizePhoneE164('+57 (300) 123-4567'), '+573001234567');
  assert.equal(normalizePhoneE164('0034 612 345 678'), '+34612345678');
  assert.equal(normalizePhoneE164('123'), null);
  assert.equal(whatsappRecipient('3001234567'), '573001234567');
  assert.equal(maskPhone('3001234567'), '+57••••••567');
});

test('clasifica prospectos, recurrencia, VIP, inactividad y no contactar', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  assert.equal(classifyCrmContact({ first_contact_at: now }, undefined, now), 'PROSPECTO');
  assert.equal(classifyCrmContact({ orders_count: 1, last_purchase_at: now }, undefined, now), 'CLIENTE_NUEVO');
  assert.equal(classifyCrmContact({ orders_count: 2, last_purchase_at: now }, undefined, now), 'CLIENTE_RECURRENTE');
  assert.equal(classifyCrmContact({ orders_count: 10, last_purchase_at: now }, undefined, now), 'VIP');
  assert.equal(classifyCrmContact({ orders_count: 2, last_purchase_at: '2025-01-01' }, undefined, now), 'INACTIVO');
  assert.equal(classifyCrmContact({ orders_count: 20, last_purchase_at: now, no_contact: true }, undefined, now), 'NO_CONTACTAR');
});

test('segmentación compila solo campos permitidos y mantiene valores parametrizados', () => {
  const definition = validateSegmentDefinition({
    combinator: 'AND',
    rules: [
      { field: 'source', operator: 'eq', value: "WHATSAPP' OR TRUE --" },
      { field: 'orders_count', operator: 'gte', value: 2 },
      { field: 'last_purchase_at', operator: 'within_days', value: 30 },
    ],
  });
  const compiled = compileSegment(definition, { startAt: 2 });
  assert.doesNotMatch(compiled.sql, /OR TRUE/);
  assert.match(compiled.sql, /\$2/);
  assert.deepEqual(compiled.params, ["WHATSAPP' OR TRUE --", 2, 30]);
  assert.throws(() => compileSegment({ combinator: 'AND', rules: [{ field: 'raw_sql', operator: 'eq', value: '1' }] }), /Campo de segmento no permitido/);
});

test('firma de webhook compara HMAC SHA-256 sobre el cuerpo original y soporta secretos múltiples', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'app-secret-test';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(validateWebhookSignature(raw, signature, secret), true);
  assert.equal(validateWebhookSignature(raw, `${signature.slice(0, -1)}0`, secret), false);
  assert.equal(validateWebhookSignature(raw, signature, 'otro_secreto, app-secret-test'), true);
  assert.equal(describeWebhookSignature(signature).format, 'meta_sha256');
});

test('firma de webhook soporta formato YCloud con timestamp y fallback de secreto', () => {
  const raw = JSON.stringify({ type: 'whatsapp.inbound_message.received' });
  const timestamp = '1729000000';
  const secret = 'whsec_4ad302be242b4c73b4b74793b07667aa';
  const hash = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');
  const validHeader = `t=${timestamp},s=${hash}`;
  const invalidHeader = `t=${timestamp},s=${hash.slice(0, -2)}99`;

  assert.equal(validateWebhookSignature(raw, validHeader, 'otro_token_desconocido'), true);
  assert.equal(validateWebhookSignature(Buffer.from(raw, 'utf8'), validHeader, 'otro_token_desconocido'), true);
  assert.equal(validateWebhookSignature(raw, invalidHeader, 'otro_token_desconocido'), false);
  assert.deepEqual(describeWebhookSignature(validHeader), { format: 'ycloud', timestamp: '1729000000' });
});

test('el token canonico del webhook prevalece sin romper la variable anterior', () => {
  assert.equal(configuration({ WHATSAPP_VERIFY_TOKEN: 'canonico' }).verifyToken, 'canonico');
  assert.equal(configuration({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'anterior' }).verifyToken, 'anterior');
  assert.equal(configuration({ WHATSAPP_VERIFY_TOKEN: 'canonico', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'anterior' }).verifyToken, 'canonico');
});

test('plantillas de campaña solo renderizan variables CRM permitidas', () => {
  const components = buildCampaignTemplateComponents(
    { body: ['contact.name', 'contact.orders_count'] },
    { 'contact.name': 'Ana', 'contact.orders_count': 4 },
  );
  assert.deepEqual(components, [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '4' }] }]);
  assert.throws(() => buildCampaignTemplateComponents({ body: ['contact.password'] }, {}), /Variable no permitida/);
});

test('Escenarios 1, 2, 6 y 16: contacto nuevo, contacto existente, deduplicación y emisión de evento SSE', async () => {
  const pool = createInMemoryCrmPool();

  // Escenario 1: Mensaje entrante de un contacto nuevo con teléfono válido y sendTime de YCloud
  const payload1 = {
    id: 'evt_ycloud_1',
    type: 'whatsapp.inbound_message.received',
    createTime: '2026-10-18T15:10:00.000Z',
    whatsappInboundMessage: {
      id: 'wamid_inbound_001',
      wamid: 'wamid.HBgMNTczMDAxMTEyMjMzFQIAEhggMDE',
      from: '+573001112233',
      to: '+573109999999',
      type: 'text',
      text: { body: 'Hola, quiero pedir dos hamburguesas' },
      sendTime: '2026-10-18T15:09:58.000Z',
      customerProfile: { name: 'Carlos Pérez' },
    },
  };

  const res1 = await processWhatsAppWebhook(pool, payload1, JSON.stringify(payload1));
  assert.equal(res1.duplicate, false);
  assert.equal(res1.processed, 1);
  assert.equal(pool.state.contacts.length, 1);
  assert.equal(pool.state.contacts[0].normalized_phone, '+573001112233');
  assert.equal(pool.state.contacts[0].display_name, 'Carlos Pérez');
  assert.equal(pool.state.conversations.length, 1);
  assert.equal(pool.state.conversations[0].unread_count, 1);
  assert.equal(pool.state.conversations[0].last_inbound_at, '2026-10-18T15:09:58.000Z');
  assert.equal(pool.state.messages.length, 1);
  assert.equal(pool.state.messages[0].text_body, 'Hola, quiero pedir dos hamburguesas');
  assert.equal(pool.state.messages[0].created_at, '2026-10-18T15:09:58.000Z');

  // Escenario 16: Emisión del evento en tiempo real tras recibir mensaje entrante
  const sseEvent = pool.state.domainEvents.find((e) => e.event_type === 'whatsapp.message.received');
  assert.ok(sseEvent, 'Debe emitir el evento whatsapp.message.received hacia el outbox SSE');
  assert.equal(sseEvent.payload.contactId, pool.state.contacts[0].id);
  assert.equal(sseEvent.payload.conversationId, pool.state.conversations[0].id);
  assert.equal(sseEvent.payload.messageId, pool.state.messages[0].id);

  // Escenario 6: Webhook duplicado (mismo rawBody / event_key y mismo provider_message_id)
  const dupRes = await processWhatsAppWebhook(pool, payload1, JSON.stringify(payload1));
  assert.equal(dupRes.duplicate, true);
  assert.equal(pool.state.messages.length, 1);
  assert.equal(pool.state.conversations[0].unread_count, 1);

  // Escenario 2: Segundo mensaje entrante del mismo contacto existente
  const payload2 = {
    id: 'evt_ycloud_2',
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: {
      id: 'wamid_inbound_002',
      from: '573001112233',
      to: '+573109999999',
      type: 'text',
      text: { body: 'Con papas francesas por favor' },
      sendTime: '2026-10-18T15:11:00.000Z',
      customerProfile: { name: 'Carlos Pérez' },
    },
  };
  const res2 = await processWhatsAppWebhook(pool, payload2, JSON.stringify(payload2));
  assert.equal(res2.processed, 1);
  assert.equal(pool.state.contacts.length, 1, 'No debe duplicar el contacto existente');
  assert.equal(pool.state.conversations.length, 1, 'Debe reutilizar la conversación activa');
  assert.equal(pool.state.conversations[0].unread_count, 2);
  assert.equal(pool.state.conversations[0].last_inbound_at, '2026-10-18T15:11:00.000Z');
  assert.equal(pool.state.messages.length, 2);
});

test('Escenarios 3 y 4: contacto con BSUID sin teléfono y posterior unificación cuando envía teléfono, protegiendo CONSUMIDOR FINAL', async () => {
  const pool = createInMemoryCrmPool();

  // Sembrar CONSUMIDOR FINAL para verificar que nunca se mezcle con WhatsApp
  pool.state.contacts.push({
    id: stateContactId(pool),
    normalized_phone: '+572222222',
    bsuid: 'CONSUMIDOR_FINAL',
    display_name: 'CONSUMIDOR FINAL',
    source: 'PRESENCIAL',
    status: 'CLIENTE_FRECUENTE',
    orders_count: 15,
    total_spent: 540000,
    deleted_at: null,
  });

  function stateContactId(p) {
    return p.state.seq.contacts++;
  }

  // Verificar rechazo si un webhook intenta usar el identificador reservado de CONSUMIDOR FINAL
  await assert.rejects(
    () =>
      __test__.ensureContact(pool, {
        phone: '2222222',
        bsuid: 'CONSUMIDOR_FINAL',
        source: 'WHATSAPP',
      }),
    /CONSUMIDOR FINAL/
  );

  // Escenario 3: Usuario sin teléfono visible y con BSUID
  const bsuidPayload = {
    id: 'evt_bsuid_1',
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: {
      id: 'wamid_bsuid_1',
      from: '',
      fromUserId: 'CO.bsuid_oculto_777',
      to: '+573109999999',
      type: 'text',
      text: { body: 'Hola, escribo desde número privado' },
      sendTime: '2026-10-18T16:00:00.000Z',
      customerProfile: { name: 'Laura BSUID', username: 'laura_bg' },
    },
  };
  await processWhatsAppWebhook(pool, bsuidPayload, JSON.stringify(bsuidPayload));
  const bsuidContact = pool.state.contacts.find((c) => c.bsuid === 'CO.bsuid_oculto_777');
  assert.ok(bsuidContact);
  assert.equal(bsuidContact.normalized_phone, null);
  assert.equal(bsuidContact.username, 'laura_bg');

  // Escenario 4: El usuario con BSUID ahora revela su teléfono E.164
  const phoneRevealPayload = {
    id: 'evt_bsuid_2',
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: {
      id: 'wamid_bsuid_2',
      from: '+573154445566',
      fromUserId: 'CO.bsuid_oculto_777',
      to: '+573109999999',
      type: 'text',
      text: { body: 'Aquí está mi número' },
      sendTime: '2026-10-18T16:02:00.000Z',
      customerProfile: { name: 'Laura BSUID', username: 'laura_bg' },
    },
  };
  await processWhatsAppWebhook(pool, phoneRevealPayload, JSON.stringify(phoneRevealPayload));
  const updatedContact = pool.state.contacts.find((c) => c.bsuid === 'CO.bsuid_oculto_777' && !c.deleted_at);
  assert.ok(updatedContact);
  assert.equal(updatedContact.normalized_phone, '+573154445566');
  assert.equal(pool.state.messages.filter((m) => m.contact_id === updatedContact.id).length, 2);
});

test('Escenario 5: mensajes entrantes con imagen, audio, video, documento y ubicación', async () => {
  const pool = createInMemoryCrmPool();
  const mediaPayloads = [
    {
      id: 'msg_img_1',
      from: '+573002223344',
      type: 'image',
      image: { id: 'media_img', link: 'https://cdn.ycloud.com/img1.jpg', caption: 'Comprobante Nequi', mime_type: 'image/jpeg' },
    },
    {
      id: 'msg_aud_1',
      from: '+573002223344',
      type: 'audio',
      audio: { id: 'media_aud', link: 'https://cdn.ycloud.com/voice.ogg', mime_type: 'audio/ogg', voice: true },
    },
    {
      id: 'msg_vid_1',
      from: '+573002223344',
      type: 'video',
      video: { id: 'media_vid', link: 'https://cdn.ycloud.com/video.mp4', caption: 'Video referencia', mime_type: 'video/mp4' },
    },
    {
      id: 'msg_doc_1',
      from: '+573002223344',
      type: 'document',
      document: { id: 'media_doc', link: 'https://cdn.ycloud.com/rut.pdf', filename: 'RUT.pdf', mime_type: 'application/pdf' },
    },
    {
      id: 'msg_loc_1',
      from: '+573002223344',
      type: 'location',
      location: { latitude: 4.711, longitude: -74.0721, name: 'Casa', address: 'Calle 100 # 15-20' },
    },
  ];

  for (const msg of mediaPayloads) {
    const body = { type: 'whatsapp.inbound_message.received', whatsappInboundMessage: msg };
    await processWhatsAppWebhook(pool, body, JSON.stringify(body));
  }

  assert.equal(pool.state.messages.length, 5);
  assert.equal(pool.state.messages[0].content.link, 'https://cdn.ycloud.com/img1.jpg');
  assert.equal(pool.state.messages[0].text_body, 'Comprobante Nequi');
  assert.equal(pool.state.messages[1].content.voice, true);
  assert.equal(pool.state.messages[2].content.link, 'https://cdn.ycloud.com/video.mp4');
  assert.equal(pool.state.messages[3].content.filename, 'RUT.pdf');
  assert.equal(pool.state.messages[4].content.latitude, 4.711);
});

test('Escenarios 7 y 9: webhook malformado y recuperación por worker tras fallo transitorio en base de datos', async () => {
  const pool = createInMemoryCrmPool();

  // Escenario 7: Webhook con mensaje sin remitente válido (malformado)
  const malformed = {
    id: 'evt_malformed',
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: { id: 'msg_bad', from: '', type: 'text', text: { body: 'Sin remitente' } },
  };
  await assert.rejects(
    () => processWhatsAppWebhook(pool, malformed, JSON.stringify(malformed)),
    (err) => err && err.code === 'CRM_PHONE_INVALID'
  );
  assert.equal(pool.state.webhooks[0].processing_status, 'FAILED');

  // Escenario 9: Webhook válido que falla en el primer intento de BD y luego se recupera con processPendingWhatsAppWebhooks
  pool.state.failNextInboundInsert = true;
  const retryablePayload = {
    id: 'evt_retry_1',
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: {
      id: 'msg_retry_ok',
      from: '+573005556677',
      type: 'text',
      text: { body: 'Mensaje recuperado por el worker' },
      sendTime: '2026-10-18T16:20:00.000Z',
    },
  };
  const reg = await registerWhatsAppWebhook(pool, retryablePayload, JSON.stringify(retryablePayload));
  await assert.rejects(() => processStoredWhatsAppWebhook(pool, reg.eventKey), /Simulated transient DB/);
  const failedRecord = pool.state.webhooks.find((w) => w.event_key === reg.eventKey);
  assert.equal(failedRecord.processing_status, 'FAILED');

  // Ahora el worker reintenta los eventos pendientes/fallidos
  const recoveredCount = await processPendingWhatsAppWebhooks(pool, 10);
  assert.equal(recoveredCount, 1);
  const updatedRecord = pool.state.webhooks.find((w) => w.event_key === reg.eventKey);
  assert.equal(updatedRecord.processing_status, 'PROCESSED');
  assert.equal(pool.state.messages.some((m) => m.provider_message_id === 'msg_retry_ok'), true);
});

test('Escenarios 10, 11, 12 y 13: envíos dentro/fuera de ventana 24h, plantillas, estados y prevención de carrera 23505', async () => {
  const pool = createInMemoryCrmPool();

  // Crear conversación con mensaje entrante reciente (ventana 24h activa)
  const inboundPayload = {
    type: 'whatsapp.inbound_message.received',
    whatsappInboundMessage: {
      id: 'wamid_win_open',
      from: '+573007778899',
      type: 'text',
      text: { body: 'Hola, ¿tienen servicio?' },
      sendTime: new Date().toISOString(),
      customerProfile: { name: 'Cliente Ventana' },
    },
  };
  await processWhatsAppWebhook(pool, inboundPayload, JSON.stringify(inboundPayload));
  const conv = pool.state.conversations[0];

  // Escenario 10: Envío de texto libre dentro de la ventana de 24 horas
  const queued = await queueConversationMessage(pool, {
    conversationId: conv.id,
    actorUserId: 10,
    text: '¡Claro que sí! Ya te tomamos el pedido.',
    idempotencyKey: 'idem-text-1',
  });
  assert.equal(queued.duplicate, false);
  assert.equal(queued.message.status, 'QUEUED');

  // Simular que el webhook whatsapp.message.updated (DELIVERED) llega ANTES de que completeJob termine
  const earlyEchoPayload = {
    type: 'whatsapp.message.updated',
    whatsappMessage: {
      id: 'ycloud_out_001',
      wamid: 'wamid.out.001',
      to: '+573007778899',
      type: 'text',
      text: { body: '¡Claro que sí! Ya te tomamos el pedido.' },
      status: 'delivered',
      sendTime: new Date().toISOString(),
    },
  };
  await processWhatsAppWebhook(pool, earlyEchoPayload, JSON.stringify(earlyEchoPayload));

  // Ahora el worker ejecuta processOne y completeJob con el mismo id devuelto por YCloud
  const fakeWhatsappClient = {
    config: { phoneNumberId: '573109999999' },
    isConfigured: () => true,
    sendText: async () => ({ id: 'ycloud_out_001', wamid: 'wamid.out.001' }),
    sendTemplate: async () => ({ id: 'ycloud_tpl_001' }),
  };
  const worker = createCrmWorker({ pool, whatsappClient: fakeWhatsappClient });
  // Habilitar una sola ejecución controlada del worker
  await worker.start();
  await worker.processOne();
  worker.stop();

  const outMessages = pool.state.messages.filter((m) => m.direction === 'OUTBOUND');
  assert.equal(outMessages.length, 1, 'No debe duplicar el mensaje saliente cuando el webhook llega antes que completeJob');
  assert.equal(outMessages[0].provider_message_id, 'ycloud_out_001');
  assert.equal(outMessages[0].status, 'DELIVERED', 'No debe degradar DELIVERED a SENT cuando completeJob finaliza después');

  // Escenario 13: Actualizaciones de estado SENT -> DELIVERED -> READ y protección contra degradación
  const readUpdate = {
    type: 'whatsapp.message.updated',
    whatsappMessage: {
      id: 'ycloud_out_001',
      status: 'read',
      readTime: new Date().toISOString(),
    },
  };
  await processWhatsAppWebhook(pool, readUpdate, JSON.stringify(readUpdate));
  assert.equal(outMessages[0].status, 'READ');
  assert.ok(outMessages[0].read_at);

  // Cerrar ventana de 24h moviendo last_inbound_at a hace 48 horas
  conv.last_inbound_at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Escenario 11: Intento de envío de texto libre fuera de la ventana de 24 horas
  await assert.rejects(
    () =>
      queueConversationMessage(pool, {
        conversationId: conv.id,
        actorUserId: 10,
        text: 'Texto fuera de ventana',
        idempotencyKey: 'idem-expired-1',
      }),
    (err) => err.code === 'WHATSAPP_SESSION_EXPIRED'
  );

  // Escenario 12: Envío de plantilla aprobada fuera de la ventana de 24 horas
  const tplQueued = await queueConversationMessage(pool, {
    conversationId: conv.id,
    actorUserId: 10,
    template: { id: 1, components: [] },
    idempotencyKey: 'idem-tpl-1',
  });
  assert.equal(tplQueued.duplicate, false);
  assert.equal(tplQueued.message.message_type, 'template');
  assert.match(tplQueued.message.text_body, /Hola \{\{1\}\}, tenemos nuevas burgers/);
});

test('Escenarios 8, 14 y 15: endpoints HTTP de webhook con firma inválida, lista priorizada de conversaciones y detalle + marcado como leído', async () => {
  const pool = createInMemoryCrmPool();
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    })
  );

  registerCrmApi(app, {
    pool,
    authenticateToken: (req, _res, next) => {
      req.user = { id: 1, username: 'admin' };
      next();
    },
    requirePermission: () => (_req, _res, next) => next(),
    whatsappClient: {
      config: { verifyToken: 'whsec_4ad302be242b4c73b4b74793b07667aa', phoneNumberId: '573109999999' },
      isConfigured: () => true,
    },
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Sembrar una conversación de campaña masiva sin respuesta (last_inbound_at = null) con fecha más reciente
    const campaignContact = {
      id: pool.state.seq.contacts++,
      normalized_phone: '+573000000001',
      display_name: 'Destinatario Campaña Masiva',
      status: 'CLIENTE_NUEVO',
      orders_count: 1,
      total_spent: 35000,
      deleted_at: null,
    };
    pool.state.contacts.push(campaignContact);
    const campaignConv = {
      id: pool.state.seq.conversations++,
      contact_id: campaignContact.id,
      channel: 'WHATSAPP',
      status: 'OPEN',
      unread_count: 0,
      first_message_at: '2026-10-18T18:00:00.000Z',
      last_message_at: '2026-10-18T18:00:00.000Z',
      last_inbound_at: null,
      last_outbound_at: '2026-10-18T18:00:00.000Z',
    };
    pool.state.conversations.push(campaignConv);
    pool.state.messages.push({
      id: pool.state.seq.messages++,
      conversation_id: campaignConv.id,
      contact_id: campaignContact.id,
      direction: 'OUTBOUND',
      message_type: 'template',
      text_body: '[Plantilla campaña]',
      status: 'DELIVERED',
      sent_by: null, // enviado por worker de campaña, no por agente manual
      created_at: '2026-10-18T18:00:00.000Z',
    });

    // Escenario 8: Webhook con firma inválida -> 401
    const badRes = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'YCloud-Signature': 't=1729000000,s=firma_invalida_0000',
      },
      body: JSON.stringify({ type: 'whatsapp.inbound_message.received' }),
    });
    assert.equal(badRes.status, 401);
    assert.equal(pool.state.webhooks.length, 0);

    // Enviar webhook válido firmado por YCloud de un cliente real
    const inboundBody = JSON.stringify({
      id: 'evt_http_real_1',
      type: 'whatsapp.inbound_message.received',
      whatsappInboundMessage: {
        id: 'wamid_http_real_1',
        from: '+573112223344',
        to: '+573109999999',
        type: 'text',
        text: { body: 'Hola Distrito, quiero hacer un pedido real' },
        sendTime: '2026-10-18T17:30:00.000Z',
        customerProfile: { name: 'Valentina Gómez' },
      },
    });
    const ts = '1729272600';
    const sig = crypto
      .createHmac('sha256', 'whsec_4ad302be242b4c73b4b74793b07667aa')
      .update(`${ts}.${inboundBody}`, 'utf8')
      .digest('hex');

    const okRes = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'YCloud-Signature': `t=${ts},s=${sig}`,
      },
      body: inboundBody,
    });
    assert.equal(okRes.status, 200);
    await new Promise((r) => setTimeout(r, 40));

    // Escenario 14: Consulta de la lista de conversaciones tras recibir mensaje nuevo
    const listRes = await fetch(`${baseUrl}/api/pedidos/admin/crm/conversations`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.conversations.length, 2);
    // El chat real con Valentina debe aparecer de #1 por encima del disparo masivo de campaña sin respuesta
    assert.equal(listData.conversations[0].display_name, 'Valentina Gómez');
    assert.equal(listData.conversations[0].unread_count, 1);
    assert.equal(listData.conversations[0].last_message_text, 'Hola Distrito, quiero hacer un pedido real');

    // Probar filtro status=CHATS (solo conversaciones con interacción de cliente/agente)
    const chatsOnlyRes = await fetch(`${baseUrl}/api/pedidos/admin/crm/conversations?status=CHATS`);
    const chatsOnlyData = await chatsOnlyRes.json();
    assert.equal(chatsOnlyData.conversations.length, 1);
    assert.equal(chatsOnlyData.conversations[0].display_name, 'Valentina Gómez');

    // Escenario 15: Consulta del detalle de la conversación y marcado de mensajes como leídos
    const convId = listData.conversations[0].id;
    const detailRes = await fetch(`${baseUrl}/api/pedidos/admin/crm/conversations/${convId}`);
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json();
    assert.equal(detailData.conversation.display_name, 'Valentina Gómez');
    assert.equal(detailData.messages.length, 1);
    assert.equal(detailData.messages[0].text_body, 'Hola Distrito, quiero hacer un pedido real');

    const readRes = await fetch(`${baseUrl}/api/pedidos/admin/crm/conversations/${convId}/read`, {
      method: 'POST',
    });
    assert.equal(readRes.status, 200);
    assert.equal(pool.state.conversations.find((c) => c.id === convId).unread_count, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
