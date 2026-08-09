const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizePhoneE164, whatsappRecipient, maskPhone } = require('../src/crm/phone');
const { classifyCrmContact } = require('../src/crm/classification');
const { compileSegment, validateSegmentDefinition } = require('../src/crm/segments');
const { configuration, validateWebhookSignature } = require('../src/whatsapp-cloud');
const { buildCampaignTemplateComponents } = require('../src/crm-service');

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

test('firma de webhook compara HMAC SHA-256 sobre el cuerpo original', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'app-secret-test';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(validateWebhookSignature(raw, signature, secret), true);
  assert.equal(validateWebhookSignature(raw, `${signature.slice(0, -1)}0`, secret), false);
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
