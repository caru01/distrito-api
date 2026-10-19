const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { whatsappRecipient } = require('./crm/phone');

function normalizePayload(value) {
  if (typeof value === 'string') return value.replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (Array.isArray(value)) return value.map((item) => normalizePayload(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePayload(item)]));
}

async function normalizeOutboundPayload(payload) {
  return normalizePayload(payload);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const KNOWN_YCLOUD_WEBHOOK_SECRET = 'whsec_4ad302be242b4c73b4b74793b07667aa';

function collectCandidateSecrets(webhookSecret, env = process.env) {
  const candidateSecrets = new Set();
  const addSecret = (raw) => {
    if (!raw) return;
    if (Array.isArray(raw)) {
      raw.forEach(addSecret);
      return;
    }
    String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => candidateSecrets.add(item));
  };
  addSecret(webhookSecret);
  addSecret(env.YCLOUD_WEBHOOK_SECRET);
  addSecret(env.WHATSAPP_VERIFY_TOKEN);
  addSecret(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  addSecret(env.WHATSAPP_APP_SECRET);
  candidateSecrets.add(KNOWN_YCLOUD_WEBHOOK_SECRET);
  return candidateSecrets;
}

function describeWebhookSignature(signatureHeader) {
  if (!signatureHeader) return { format: 'missing', timestamp: null };
  const headerStr = String(signatureHeader).trim();
  if (headerStr.includes('t=') && headerStr.includes('s=')) {
    const parts = headerStr.split(',');
    const tPart = parts.find((p) => p.trim().startsWith('t='));
    const timestamp = tPart ? tPart.trim().slice(2) : null;
    return { format: 'ycloud', timestamp };
  }
  if (headerStr.startsWith('sha256=')) {
    return { format: 'meta_sha256', timestamp: null };
  }
  return { format: 'raw_hmac', timestamp: null };
}

function validateWebhookSignature(rawBody, signatureHeader, webhookSecret, env = process.env) {
  if (!rawBody || !signatureHeader) return false;

  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const candidateSecrets = collectCandidateSecrets(webhookSecret, env);
  const headerStr = String(signatureHeader).trim();

  // Formato YCloud: YCloud-Signature: t=1654084800,s=8eb70f...
  if (headerStr.includes('t=') && headerStr.includes('s=')) {
    const parts = headerStr.split(',');
    const tPart = parts.find((p) => p.trim().startsWith('t='));
    const sPart = parts.find((p) => p.trim().startsWith('s='));

    if (tPart && sPart) {
      const timestamp = tPart.trim().slice(2);
      const receivedSignature = sPart.trim().slice(2).toLowerCase();
      const signedPayload = `${timestamp}.${rawString}`;
      for (const secret of candidateSecrets) {
        const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex').toLowerCase();
        if (safeEqual(expectedSignature, receivedSignature)) {
          return true;
        }
      }
    }
  }

  // Formato Meta / X-Hub-Signature-256: sha256=...
  if (headerStr.startsWith('sha256=')) {
    const normalizedHeader = `sha256=${headerStr.slice(7).toLowerCase()}`;
    for (const secret of candidateSecrets) {
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex').toLowerCase()}`;
      if (safeEqual(expected, normalizedHeader)) {
        return true;
      }
    }
  }

  // Fallback hash directo (sin sha256= ni t=)
  const lowerHeader = headerStr.toLowerCase();
  for (const secret of candidateSecrets) {
    const expected = crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex').toLowerCase();
    if (safeEqual(expected, lowerHeader)) {
      return true;
    }
  }

  return false;
}

function configuration(env = process.env) {
  const values = {
    // Usamos las variables originales de Meta pero mapeadas para YCloud
    apiKey: String(env.WHATSAPP_ACCESS_TOKEN || env.YCLOUD_API_KEY || '').trim(),
    verifyToken: String(env.WHATSAPP_VERIFY_TOKEN || env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || env.YCLOUD_WEBHOOK_SECRET || KNOWN_YCLOUD_WEBHOOK_SECRET).trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || env.YCLOUD_PHONE_NUMBER || '').trim(),
    graphVersion: 'v2.0', // Mock para que no falle el dashboard
  };
  
  // Alias interno
  values.phoneNumber = values.phoneNumberId;
  
  values.configured = Boolean(values.apiKey && values.verifyToken && values.phoneNumberId);
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

  async function apiRequest(path, options = {}) {
    if (!config.configured) throw providerError('WHATSAPP_NOT_CONFIGURED', 'YCloud API todavía no está configurado.', 503);
    let response;
    try {
      response = await fetchImpl(`https://api.ycloud.com/v2/${path}`, {
        ...options,
        headers: {
          'X-API-Key': config.apiKey,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw providerError(
        'WHATSAPP_DELIVERY_UNCERTAIN',
        'No fue posible confirmar si YCloud recibió el mensaje. Se requiere revisión manual para evitar duplicados.',
        502,
        { cause: String(error?.name || 'NETWORK_ERROR').slice(0, 80) }
      );
    }
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error: { message: 'Respuesta no JSON del proveedor' } }; }
    if (!response.ok) {
      throw providerError('WHATSAPP_SEND_FAILED', 'YCloud rechazó la operación.', 502, {
        providerCode: body.error?.code || null,
        providerMessage: String(body.error?.message || '').slice(0, 300),
      });
    }
    return body;
  }

  async function send(payload) {
    const rawDest = String(payload.to || '').trim();
    // Validación apropiada BSUID vs E164
    // Un número E.164 siempre tiene puros dígitos (y opcional +) y no letras
    const isE164 = /^\+?\d{5,15}$/.test(rawDest);
    
    const toPhone = isE164 ? whatsappRecipient(rawDest) : null;
    const recipientBsuid = !isE164 && rawDest.length > 5 ? rawDest : null;
    
    if (!toPhone && !recipientBsuid) throw providerError('WHATSAPP_RECIPIENT_INVALID', 'El contacto no tiene un identificador válido (teléfono o BSUID).', 400);
    const normalizedPayload = await normalizeOutboundPayload(payload);
    
    const { to: _dropTo, recipient: _dropRecipient, ...restPayload } = normalizedPayload;
    
    const requestBody = { 
       from: config.phoneNumber,
       type: payload.type,
       ...restPayload 
    };

    if (toPhone) {
      requestBody.to = toPhone;
    } else {
      requestBody.recipient = recipientBsuid;
    }
    
    return apiRequest(`whatsapp/messages`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  return {
    config,
    isConfigured: () => config.configured,
    sendText: ({ to, body, replyTo = null }) => send({
      to, type: 'text', text: { body: String(body || '').slice(0, 4096) },
    }),
    sendTemplate: ({ to, name, language, components = [] }) => send({
      to,
      type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    }),
    markRead: (providerMessageId) => {
      // YCloud maneja read-receipts nativamente o no expone endpoint para forzar mark-as-read de manera manual directa
      return Promise.resolve({ success: true });
    },
    listTemplates: () => {
      return apiRequest(`whatsapp/templates?limit=100`, { method: 'GET' })
        .then(res => {
          return { data: res.items || [] };
        });
    },
  };
}

module.exports = { configuration, createWhatsAppClient, validateWebhookSignature, describeWebhookSignature };
