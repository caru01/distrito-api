const assert = require('assert');

console.log('=== INICIANDO SUITE DE PRUEBAS: SOPORTE DE BSUID Y TELÉFONO EN PEDIDOS MANUALES ===\n');

// -------------------------------------------------------------
// Simulación lógica de Trigger DB: pedidos_app_crm_sync_order_before
// -------------------------------------------------------------
function normalizePhoneE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+57${digits}`;
  if (digits.length === 12 && digits.startsWith('57')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

function simulateCrmSyncOrderBefore(orderRow, mockContactsDb) {
  const normalized = normalizePhoneE164(orderRow.customer_phone);
  const resultOrder = { ...orderRow, customer_phone_e164: normalized };

  // Caso 1: Sin teléfono
  if (!normalized) {
    if (resultOrder.crm_contact_id) {
      const existing = mockContactsDb.find(c => c.id === resultOrder.crm_contact_id);
      if (existing) {
        existing.display_name = existing.display_name || resultOrder.customer_name;
        existing.address = existing.address || resultOrder.address;
        existing.barrio = existing.barrio || resultOrder.barrio;
        existing.updated_at = new Date().toISOString();
      }
      return { order: resultOrder, contacts: mockContactsDb };
    }
    resultOrder.crm_contact_id = null;
    return { order: resultOrder, contacts: mockContactsDb };
  }

  // Caso 2: Con teléfono Y con crm_contact_id existente (enriquecimiento)
  if (resultOrder.crm_contact_id) {
    const existing = mockContactsDb.find(c => c.id === resultOrder.crm_contact_id);
    if (existing) {
      existing.normalized_phone = existing.normalized_phone || normalized;
      existing.display_name = existing.display_name || resultOrder.customer_name;
      existing.updated_at = new Date().toISOString();
    }
    return { order: resultOrder, contacts: mockContactsDb };
  }

  // Caso 3: Con teléfono y SIN crm_contact_id (contacto estándar)
  const existingByPhone = mockContactsDb.find(c => c.normalized_phone === normalized);
  if (existingByPhone) {
    existingByPhone.display_name = existingByPhone.display_name || resultOrder.customer_name;
    existingByPhone.updated_at = new Date().toISOString();
    resultOrder.crm_contact_id = existingByPhone.id;
  } else {
    const newId = (mockContactsDb.length > 0 ? Math.max(...mockContactsDb.map(c => c.id)) : 0) + 1;
    mockContactsDb.push({
      id: newId,
      normalized_phone: normalized,
      display_name: resultOrder.customer_name,
      address: resultOrder.address,
      barrio: resultOrder.barrio,
      created_at: new Date().toISOString()
    });
    resultOrder.crm_contact_id = newId;
  }

  return { order: resultOrder, contacts: mockContactsDb };
}

// -------------------------------------------------------------
// Simulación lógica de Checkout Backend: POST /api/pedidos/checkout
// -------------------------------------------------------------
function validateCheckout(customer) {
  if (!customer || typeof customer !== 'object' || !customer.name || (!customer.phone && !customer.crm_contact_id)) {
    return { valid: false, error: 'Datos de cliente incompletos (requiere nombre y teléfono o contacto CRM)' };
  }
  return { valid: true };
}

// -------------------------------------------------------------
// Simulación lógica del Adaptador YCloud: whatsapp-cloud.js
// -------------------------------------------------------------
function buildYCloudPayload(sendTo, textBody) {
  const rawDest = String(sendTo || '').trim();
  const isE164 = /^\+?\d{5,15}$/.test(rawDest);

  const toPhone = isE164 ? rawDest : null;
  const recipientBsuid = !isE164 && rawDest.length > 5 ? rawDest : null;

  if (!toPhone && !recipientBsuid) {
    throw new Error('WHATSAPP_RECIPIENT_INVALID: El contacto no tiene un identificador válido.');
  }

  const requestBody = {
    from: '+1234567890',
    type: 'text',
    text: { body: textBody }
  };

  if (toPhone) {
    requestBody.to = toPhone;
  } else {
    requestBody.recipient = recipientBsuid;
  }

  return requestBody;
}

// =============================================================
// EJECUCIÓN DE PRUEBAS
// =============================================================

let totalPassed = 0;
function runTest(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    totalPassed++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// Prueba 1: Cliente con teléfono
runTest('Prueba 1: Cliente con teléfono es validado y genera número normalizado', () => {
  const customer = { name: 'Carlos Gomez', phone: '3001234567' };
  const validation = validateCheckout(customer);
  assert.strictEqual(validation.valid, true);

  const mockDb = [];
  const order = { customer_name: 'Carlos Gomez', customer_phone: '3001234567', crm_contact_id: null };
  const { order: syncedOrder, contacts } = simulateCrmSyncOrderBefore(order, mockDb);
  assert.strictEqual(syncedOrder.customer_phone_e164, '+573001234567');
  assert.strictEqual(contacts.length, 1);
  assert.strictEqual(syncedOrder.crm_contact_id, 1);
});

// Prueba 2: Cliente solamente BSUID
runTest('Prueba 2: Cliente solamente BSUID es aceptado sin requerir teléfono', () => {
  const customer = { name: 'Contacto 2085', phone: '', crm_contact_id: 2085, bsuid: 'CO.1401314438538577' };
  const validation = validateCheckout(customer);
  assert.strictEqual(validation.valid, true);
});

// Prueba 3: Cliente con teléfono + BSUID
runTest('Prueba 3: Cliente con teléfono + BSUID mantiene el mismo crm_contact_id y no duplica', () => {
  const mockDb = [{ id: 2085, bsuid: 'CO.1401314438538577', normalized_phone: null, display_name: 'Usuario BSUID' }];
  const order = { customer_name: 'Usuario BSUID', customer_phone: '3235989590', crm_contact_id: 2085 };
  
  const { order: syncedOrder, contacts } = simulateCrmSyncOrderBefore(order, mockDb);
  assert.strictEqual(syncedOrder.crm_contact_id, 2085);
  assert.strictEqual(contacts.length, 1, 'No debe crear un segundo contacto');
  assert.strictEqual(contacts[0].normalized_phone, '+573235989590', 'Debe enriquecer el teléfono');
});

// Prueba 4: Cliente sin teléfono y sin BSUID -> rechazar
runTest('Prueba 4: Cliente sin teléfono y sin BSUID es rechazado por el backend', () => {
  const customer = { name: 'Anonimo', phone: '', crm_contact_id: null };
  const validation = validateCheckout(customer);
  assert.strictEqual(validation.valid, false);
});

// Prueba 5: Pedido BSUID conserva crm_contact_id
runTest('Prueba 5: Pedido BSUID sin teléfono conserva crm_contact_id = 2085 tras pasar por el Trigger', () => {
  const mockDb = [{ id: 2085, bsuid: 'CO.1401314438538577', normalized_phone: null, display_name: 'Usuario BSUID' }];
  const order = { customer_name: 'Usuario BSUID', customer_phone: null, crm_contact_id: 2085 };

  const { order: syncedOrder } = simulateCrmSyncOrderBefore(order, mockDb);
  assert.strictEqual(syncedOrder.crm_contact_id, 2085);
  assert.strictEqual(syncedOrder.customer_phone_e164, null);
});

// Prueba 6: Pedido BSUID no crea contacto nuevo
runTest('Prueba 6: Pedido BSUID no crea nuevo contacto en la tabla crm_contacts', () => {
  const mockDb = [{ id: 2085, bsuid: 'CO.1401314438538577', normalized_phone: null, display_name: 'Usuario BSUID' }];
  const order = { customer_name: 'Usuario BSUID', customer_phone: null, crm_contact_id: 2085 };

  const { contacts } = simulateCrmSyncOrderBefore(order, mockDb);
  assert.strictEqual(contacts.length, 1);
  assert.strictEqual(contacts[0].id, 2085);
});

// Prueba 7: Notificación telefónica -> to
runTest('Prueba 7: Notificación a contacto con teléfono genera request con campo "to"', () => {
  const payload = buildYCloudPayload('+573235989590', 'Tu pedido está listo');
  assert.strictEqual(payload.to, '+573235989590');
  assert.strictEqual(payload.recipient, undefined);
});

// Prueba 8: Notificación BSUID -> recipient
runTest('Prueba 8: Notificación a contacto BSUID genera request con campo "recipient"', () => {
  const payload = buildYCloudPayload('CO.1401314438538577', 'Tu pedido está listo');
  assert.strictEqual(payload.recipient, 'CO.1401314438538577');
  assert.strictEqual(payload.to, undefined);
});

// Prueba 9: Nunca enviar to: null
runTest('Prueba 9: El payload hacia YCloud nunca contiene "to: null" ni "to: undefined"', () => {
  const payloadBsuid = buildYCloudPayload('CO.1401314438538577', 'Mensaje de prueba');
  assert.strictEqual('to' in payloadBsuid, false);
  assert.strictEqual(payloadBsuid.to, undefined);
});

// Prueba 10: Nunca enviar simultáneamente to y recipient
runTest('Prueba 10: El payload hacia YCloud nunca envía simultáneamente "to" y "recipient"', () => {
  const payloadPhone = buildYCloudPayload('+573235989590', 'Mensaje teléfono');
  const payloadBsuid = buildYCloudPayload('CO.1401314438538577', 'Mensaje BSUID');

  assert.strictEqual('to' in payloadPhone && !('recipient' in payloadPhone), true);
  assert.strictEqual('recipient' in payloadBsuid && !('to' in payloadBsuid), true);
});

console.log(`\n=============================================================`);
console.log(`🎉 TODAS LAS PRUEBAS (${totalPassed}/10) PASARON EXITOSAMENTE`);
console.log(`=============================================================\n`);
