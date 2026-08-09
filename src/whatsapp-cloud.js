const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { whatsappRecipient } = require('./crm/phone');

const unicodeModuleUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'distrito-shared', 'src', 'unicode.js')).href;
let unicodeModulePromise;

function normalizePayload(value, normalizeText) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map((item) => normalizePayload(item, normalizeText));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePayload(item, normalizeText)]));
}

async function normalizeOutboundPayload(payload) {
  unicodeModulePromise ||= import(unicodeModuleUrl);
  const { normalizeUnicodeText } = await unicodeModulePromise;
  return normalizePayload(payload, normalizeUnicodeText);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !rawBody || !signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, signatureHeader);
}

function configuration(env = process.env) {
  const values = {
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    appSecret: String(env.WHATSAPP_APP_SECRET || '').trim(),
    // Nombre canonico solicitado por Meta/Distrito BG. El alias anterior se
    // conserva durante la rotacion para no interrumpir el webhook productivo.
    verifyToken: String(env.WHATSAPP_VERIFY_TOKEN || env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    businessAccountId: String(env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim(),
    graphVersion: String(env.WHATSAPP_GRAPH_API_VERSION || '').trim(),
  };
  values.configured = Boolean(values.accessToken && values.appSecret && values.verifyToken
    && values.phoneNumberId && values.businessAccountId && /^v\d+\.\d+$/.test(values.graphVersion));
  return values;
}

function providerError(code, message, statusCode = 502, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function createWhatsAppClient({ env = process.env, fetchImpl = global.fetch } = {}) {
  const config = configuration(env);

  async function graphRequest(path, options = {}) {
    if (!config.configured) throw providerError('WHATSAPP_NOT_CONFIGURED', 'WhatsApp Cloud API todavía no está configurado.', 503);
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw providerError(
        'WHATSAPP_DELIVERY_UNCERTAIN',
        'No fue posible confirmar si Meta recibió el mensaje. Se requiere revisión manual para evitar duplicados.',
        502,
        { cause: String(error?.name || 'NETWORK_ERROR').slice(0, 80) }
      );
    }
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error: { message: 'Respuesta no JSON del proveedor' } }; }
    if (!response.ok) {
      throw providerError('WHATSAPP_SEND_FAILED', 'Meta rechazó la operación de WhatsApp.', 502, {
        providerCode: body.error?.code || null,
        providerSubcode: body.error?.error_subcode || null,
        providerMessage: String(body.error?.message || '').slice(0, 300),
      });
    }
    return body;
  }

  async function send(payload) {
    const to = whatsappRecipient(payload.to);
    if (!to) throw providerError('WHATSAPP_RECIPIENT_INVALID', 'El contacto no tiene un teléfono colombiano válido.', 400);
    const normalizedPayload = await normalizeOutboundPayload(payload);
    return graphRequest(`${config.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...normalizedPayload, to }),
    });
  }

  return {
    config,
    isConfigured: () => config.configured,
    sendText: ({ to, body, replyTo = null }) => send({
      to, type: 'text', text: { preview_url: false, body: String(body || '').slice(0, 4096) },
      ...(replyTo ? { context: { message_id: replyTo } } : {}),
    }),
    sendTemplate: ({ to, name, language, components = [] }) => send({
      to,
      type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    }),
    markRead: (providerMessageId) => graphRequest(`${config.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: providerMessageId }),
    }),
    listTemplates: () => graphRequest(`${config.businessAccountId}/message_templates?limit=250&fields=id,name,status,category,language,components,quality_score`),
  };
}

module.exports = { configuration, createWhatsAppClient, validateWebhookSignature };
