const https = require('https');
const http = require('http');

/**
 * Normaliza el número de teléfono para envío de SMS
 * Si tiene 10 dígitos (Colombia celular ej. 3228236926), antepone el prefijo de país 57
 */
function normalizePhoneForSms(rawPhone, defaultCountryCode = '57') {
  if (!rawPhone) return '';
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length === 10) {
    return defaultCountryCode + digits;
  }
  if (digits.startsWith(defaultCountryCode)) {
    return digits;
  }
  return digits;
}

/**
 * Cliente Integrado de SMS Gateway Multi-Proveedor
 * Soporta:
 * 1. Hablame Colombia (Líder SMS en Colombia)
 * 2. Twilio (Proveedor global)
 * 3. Gateway Genérico HTTP (Webhook / REST API para cualquier proveedor como Masiv, Infobip, Sinch)
 */
class SmsGateway {
  constructor(env = process.env) {
    this.env = env;
  }

  get provider() {
    if (this.env.SMS_PROVIDER) {
      return this.env.SMS_PROVIDER.toLowerCase().trim();
    }
    if (this.env.HABLAME_API_KEY || this.env.HABLAME_ACCOUNT) return 'hablame';
    if (this.env.TWILIO_ACCOUNT_SID && this.env.TWILIO_AUTH_TOKEN) return 'twilio';
    if (this.env.SMS_GATEWAY_URL) return 'custom';
    return 'none';
  }

  isConfigured() {
    return this.provider !== 'none';
  }

  /**
   * Envía un mensaje de texto SMS al teléfono especificado
   * @param {Object} params
   * @param {string} params.to - Número celular destinatario
   * @param {string} params.message - Contenido del mensaje de texto
   * @param {string} [params.code] - Código OTP si aplica
   */
  async sendSms({ to, message, code = '' }) {
    const provider = this.provider;
    const cleanPhone = normalizePhoneForSms(to);

    console.log(`[sms_gateway] Despachando SMS a ${cleanPhone} usando proveedor: "${provider}"`);

    switch (provider) {
      case 'hablame':
        return this._sendHablame({ phone: cleanPhone, message });
      case 'twilio':
        return this._sendTwilio({ phone: cleanPhone, message });
      case 'custom':
        return this._sendCustomGateway({ phone: cleanPhone, message, code });
      default:
        console.warn(`[sms_gateway] No hay un proveedor de SMS Gateway configurado en .env (SMS_PROVIDER, HABLAME_*, TWILIO_*, SMS_GATEWAY_URL)`);
        return {
          success: false,
          provider: 'none',
          error: 'SMS_GATEWAY_NOT_CONFIGURED',
          message: 'Configura las credenciales de tu proveedor de SMS en las variables de entorno.',
        };
    }
  }

  /**
   * 1. Hablame Colombia API (v5 moderna con fallback a v3)
   * Documentación: https://hablame.co
   */
  async _sendHablame({ phone, message }) {
    const apiKey = this.env.HABLAME_API_KEY || this.env.HABLAME_KEY;
    const account = this.env.HABLAME_ACCOUNT;
    const token = this.env.HABLAME_TOKEN;

    if (!apiKey && !account) {
      throw new Error('Hablame requiere HABLAME_API_KEY en variables de entorno');
    }

    // 1.1 Intentar API v5 moderna (recomendada)
    if (apiKey) {
      const payloadV5 = JSON.stringify({
        priority: true,
        messages: [
          {
            to: phone,
            text: message,
          },
        ],
      });

      const headersV5 = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Hablame-Key': apiKey.trim(),
        'Content-Length': Buffer.byteLength(payloadV5),
      };

      try {
        const resV5 = await this._postJson('https://www.hablame.co/api/sms/v5/send', payloadV5, headersV5, 'Hablame v5');
        if (resV5.success) {
          return resV5;
        }
      } catch (err) {
        console.warn('[sms_gateway] Hablame v5 fallo, intentando v3 legacy:', err.message);
      }
    }

    // 1.2 Fallback API v3 legacy
    const payloadV3 = JSON.stringify({
      toNumber: phone,
      sms: message,
      flash: '0',
      sc: this.env.HABLAME_SC || '89003',
    });

    const headersV3 = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadV3),
    };
    if (account) headersV3['account'] = account;
    if (apiKey) headersV3['apiKey'] = apiKey;
    if (token) headersV3['token'] = token;

    return this._postJson('https://api103.hablame.co/api/sms/v3/send/priority', payloadV3, headersV3, 'Hablame v3');
  }

  /**
   * 2. Twilio Programmable SMS API
   * Documentación: https://www.twilio.com/docs/sms
   */
  async _sendTwilio({ phone, message }) {
    const accountSid = this.env.TWILIO_ACCOUNT_SID;
    const authToken = this.env.TWILIO_AUTH_TOKEN;
    const fromPhone = this.env.TWILIO_PHONE_NUMBER || this.env.TWILIO_FROM;
    const messagingServiceSid = this.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!accountSid || !authToken) {
      throw new Error('Twilio requiere TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN');
    }

    const e164Phone = phone.startsWith('+') ? phone : '+' + phone;

    const params = new URLSearchParams();
    params.append('To', e164Phone);
    params.append('Body', message);

    if (messagingServiceSid) {
      params.append('MessagingServiceSid', messagingServiceSid);
    } else if (fromPhone) {
      params.append('From', fromPhone);
    } else {
      throw new Error('Twilio requiere TWILIO_PHONE_NUMBER o TWILIO_MESSAGING_SERVICE_SID');
    }

    const postData = params.toString();
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    return new Promise((resolve) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': authHeader,
        },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[sms_gateway] SMS Twilio enviado exitosamente a ${e164Phone} (SID: ${data.sid})`);
              resolve({ success: true, provider: 'twilio', sid: data.sid, status: data.status });
            } else {
              console.error(`[sms_gateway] Error de Twilio (${res.statusCode}):`, data);
              resolve({ success: false, provider: 'twilio', error: data.message || 'Error Twilio' });
            }
          } catch {
            resolve({ success: false, provider: 'twilio', error: 'Respuesta inválida de Twilio' });
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[sms_gateway] Error de conexión con Twilio:`, err.message);
        resolve({ success: false, provider: 'twilio', error: err.message });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 3. Gateway Genérico HTTP (Webhook / REST API para cualquier proveedor SMS)
   */
  async _sendCustomGateway({ phone, message, code }) {
    const rawUrl = this.env.SMS_GATEWAY_URL;
    const method = (this.env.SMS_GATEWAY_METHOD || 'POST').toUpperCase();
    const token = this.env.SMS_GATEWAY_API_KEY || this.env.SMS_GATEWAY_TOKEN;
    const headerName = this.env.SMS_GATEWAY_HEADER || 'Authorization';
    const headerPrefix = this.env.SMS_GATEWAY_HEADER_PREFIX || (headerName === 'Authorization' ? 'Bearer ' : '');

    let headers = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers[headerName] = `${headerPrefix}${token}`.trim();
    }

    if (this.env.SMS_GATEWAY_CUSTOM_HEADERS) {
      try {
        const extra = JSON.parse(this.env.SMS_GATEWAY_CUSTOM_HEADERS);
        headers = { ...headers, ...extra };
      } catch (_) {}
    }

    let payloadString = '';
    if (this.env.SMS_GATEWAY_BODY_TEMPLATE) {
      payloadString = this.env.SMS_GATEWAY_BODY_TEMPLATE
        .replace(/{{to}}/g, phone)
        .replace(/{{phone}}/g, phone)
        .replace(/{{message}}/g, message)
        .replace(/{{code}}/g, code);
    } else {
      payloadString = JSON.stringify({
        to: phone,
        phone: phone,
        message: message,
        text: message,
        code: code,
      });
    }

    headers['Content-Length'] = Buffer.byteLength(payloadString);

    return this._postJson(rawUrl, payloadString, headers, 'Custom Gateway', method);
  }

  _postJson(targetUrl, payload, headers, providerName, method = 'POST') {
    return new Promise((resolve) => {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(targetUrl, {
        method: method,
        headers: headers,
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          const isOk = res.statusCode >= 200 && res.statusCode < 300;
          if (isOk) {
            console.log(`[sms_gateway] SMS enviado exitosamente con ${providerName} a destino.`);
            resolve({ success: true, provider: providerName, response: body });
          } else {
            console.warn(`[sms_gateway] ${providerName} respondió con código ${res.statusCode}:`, body);
            resolve({ success: false, provider: providerName, statusCode: res.statusCode, error: body });
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[sms_gateway] Error de conexión con ${providerName}:`, err.message);
        resolve({ success: false, provider: providerName, error: err.message });
      });

      req.write(payload);
      req.end();
    });
  }
}

let defaultGateway = null;

function getSmsGateway(env = process.env) {
  if (!defaultGateway) {
    defaultGateway = new SmsGateway(env);
  }
  return defaultGateway;
}

module.exports = {
  SmsGateway,
  getSmsGateway,
  normalizePhoneForSms,
};
