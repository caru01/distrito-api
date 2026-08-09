const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createWhatsAppClient } = require('../src/whatsapp-cloud');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'distrito-shared', 'src', 'orderMessages.js')).href;

test('WhatsApp conserva emojis y Unicode despues de codificar la URL', async () => {
  const { buildNewOrderWhatsAppMessage, createWhatsAppUrl } = await import(moduleUrl);
  const message = buildNewOrderWhatsAppMessage({
    orderId: 257,
    customer: {
      name: 'María José',
      phone: '3235989590',
      deliveryType: 'domicilio',
      address: 'Cra. 19 #13-1',
      barrio: 'La Elvira',
      paymentMethod: 'Efectivo',
      cashAmount: 100000,
    },
    items: [{ title: 'Combo Básico', quantity: 1, price: 30000 }],
    trackingUrl: 'https://www.distritobg.app/rastrear/257?c=9590',
    deliveryFee: 5000,
    total: 35000,
    change: 65000,
  });
  const url = createWhatsAppUrl('3235989590', message);
  const encodedMessage = url.split('?text=')[1];

  assert.equal(decodeURIComponent(encodedMessage), message);
  assert.match(encodedMessage, /^%F0%9F%8D%94/);
  assert.match(message, /🍔 NUEVA ORDEN/);
  assert.match(message, /🚚 Entrega a domicilio/);
  assert.match(message, /María José/);
  assert.doesNotMatch(message, /\uFFFD/);
});

test('WhatsApp elimina UTF-16 invalido antes de encodeURIComponent', async () => {
  const { createWhatsAppUrl, normalizeWhatsAppMessage } = await import(moduleUrl);
  const damaged = `Pedido \uFFFD listo \uD83D`;
  const normalized = normalizeWhatsAppMessage(damaged);

  assert.equal(normalized, 'Pedido  listo ');
  assert.doesNotThrow(() => createWhatsAppUrl('3001234567', damaged));
  assert.doesNotMatch(decodeURIComponent(createWhatsAppUrl('3001234567', damaged).split('?text=')[1]), /\uFFFD/);
});

test('WhatsApp Cloud API comparte la normalizacion Unicode del mensaje', async () => {
  let requestBody;
  const client = createWhatsAppClient({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'test-token',
      WHATSAPP_APP_SECRET: 'test-secret',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify',
      WHATSAPP_PHONE_NUMBER_ID: 'phone-id',
      WHATSAPP_BUSINESS_ACCOUNT_ID: 'business-id',
      WHATSAPP_GRAPH_API_VERSION: 'v23.0',
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, text: async () => '{"messages":[{"id":"wamid.test"}]}' };
    },
  });

  await client.sendText({ to: '3001234567', body: `🍔 Pedido de Mari\u0301a \uFFFD listo` });

  assert.equal(requestBody.text.body, '🍔 Pedido de María  listo');
  assert.doesNotMatch(requestBody.text.body, /\uFFFD/);
});
