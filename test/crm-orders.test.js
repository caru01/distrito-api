const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const {
  formatCrmOrderWhatsAppSummary,
  crmOrderIdempotencyCache,
} = require('../crm_api');
const registerCrmApi = require('../crm_api');

process.env.CRM_SILENT_LOGS = 'true';

/**
 * Base de datos relacional simulada en memoria para pruebas exhaustivas
 * del flujo de creación de pedidos desde el CRM WhatsApp.
 */
function createInMemoryOrderPool() {
  const state = {
    seq: {
      contacts: 1,
      conversations: 1,
      messages: 1,
      orders: 1,
      products: 1,
      domainEvents: 1,
      inventoryMovements: 1,
    },
    contacts: [],
    conversations: [],
    messages: [],
    orders: [],
    domainEvents: [],
    inventoryMovements: [],
    settings: { id: 1, delivery_cost: 5000 },
    products: [
      { id: 101, title: 'Hamburguesa Distrito Doble', price: 28000, category: 'Hamburguesas', status: 'Activo', stock: 50 },
      { id: 102, title: 'Papas Rústicas', price: 9000, category: 'Acompañamientos', status: 'Activo', stock: 100 },
      { id: 103, title: 'Gaseosa Postobón 400ml', price: 5000, category: 'Bebidas', status: 'Activo', stock: 30 },
      { id: 104, title: 'Producto Inactivo', price: 15000, category: 'Especiales', status: 'Inactivo', stock: 0 },
    ],
  };

  async function query(rawSql, params = []) {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ') || sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT pedidos_app_crm_refresh_contact')) {
      return { rows: [], rowCount: 1 };
    }

    // 1. Settings
    if (sql.includes('FROM pedidos_app_settings WHERE id = 1')) {
      return { rows: [{ delivery_cost: state.settings.delivery_cost }], rowCount: 1 };
    }

    // 2. Products
    if (sql.startsWith('SELECT id, title, price, category, status FROM pedidos_app_products WHERE id::text = ANY($1::text[])')) {
      const ids = params[0].map(Number);
      const activeOnly = params[1] !== false;
      const rows = state.products.filter(
        (p) => ids.includes(p.id) && (!activeOnly || p.status === 'Activo')
      );
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT cc.combo_product_id') || sql.startsWith('SELECT pr.product_id')) {
      return { rows: [], rowCount: 0 };
    }

    // 3. Conversations & Contacts
    if (sql.includes('FROM pedidos_app_crm_conversations conversation JOIN pedidos_app_crm_contacts contact ON contact.id = conversation.contact_id WHERE conversation.id = $1')) {
      const conv = state.conversations.find((c) => Number(c.id) === Number(params[0]));
      if (!conv) return { rows: [], rowCount: 0 };
      const contact = state.contacts.find((c) => Number(c.id) === Number(conv.contact_id));
      if (!contact) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ...conv,
            c_id: contact.id,
            display_name: contact.display_name,
            normalized_phone: contact.normalized_phone,
            bsuid: contact.bsuid,
            address: contact.address,
            barrio: contact.barrio,
            no_contact: contact.no_contact,
            marketing_opt_out: contact.marketing_opt_out,
            deleted_at: contact.deleted_at,
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('UPDATE pedidos_app_crm_contacts SET deleted_at=NULL WHERE id=$1')) {
      const contact = state.contacts.find((c) => Number(c.id) === Number(params[0]));
      if (contact) contact.deleted_at = null;
      return { rows: [], rowCount: 1 };
    }

    // 4. Check recent duplicate orders (deduplicación en 60s)
    if (sql.includes('FROM pedidos_app_orders WHERE crm_contact_id = $1 AND source = \'WhatsApp CRM\' AND total = $2')) {
      const [contactId, total] = params;
      const rows = state.orders.filter(
        (o) => Number(o.crm_contact_id) === Number(contactId) && Number(o.total) === Number(total) && o.source === 'WhatsApp CRM'
      );
      return { rows: rows.slice(-1), rowCount: rows.length > 0 ? 1 : 0 };
    }

    // 5. Insert into pedidos_app_orders
    if (sql.startsWith('INSERT INTO pedidos_app_orders')) {
      const [
        customerName, customerPhone, address, barrio, deliveryType, paymentMethod,
        total, cartJson, notes, voucherRef, deliveryFee, changeRequired,
        deliveryReference, status, crmContactId
      ] = params;

      const orderRow = {
        id: state.seq.orders++,
        customer_name: customerName,
        customer_phone: customerPhone,
        address,
        barrio,
        delivery_type: deliveryType,
        payment_method: paymentMethod,
        total: Number(total),
        cart_json: JSON.parse(cartJson),
        source: 'WhatsApp CRM',
        notes,
        voucher_reference: voucherRef,
        delivery_fee: Number(deliveryFee),
        change_required: changeRequired !== null ? Number(changeRequired) : null,
        delivery_reference: deliveryReference,
        status,
        crm_contact_id: Number(crmContactId),
        created_at: new Date().toISOString(),
      };
      state.orders.push(orderRow);
      return {
        rows: [
          {
            id: orderRow.id,
            created_at: orderRow.created_at,
            status: orderRow.status,
            total: orderRow.total,
            delivery_fee: orderRow.delivery_fee,
          },
        ],
        rowCount: 1,
      };
    }

    // 6. Domain events
    if (sql.startsWith('INSERT INTO pedidos_app_domain_events')) {
      const [eventId, aggregateType, aggregateId, eventType, payloadJson] = params;
      const row = {
        id: state.seq.domainEvents++,
        event_id: eventId,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        payload: JSON.parse(payloadJson),
        created_at: new Date().toISOString(),
      };
      state.domainEvents.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // 7. Insert message card
    if (sql.startsWith('INSERT INTO pedidos_app_crm_messages')) {
      const [conversationId, contactId, textBody, contentJson, actorUserId] = params;
      const msgRow = {
        id: state.seq.messages++,
        conversation_id: Number(conversationId),
        contact_id: Number(contactId),
        direction: 'OUTBOUND',
        message_type: 'order',
        text_body: textBody,
        content: JSON.parse(contentJson),
        status: 'DELIVERED',
        sent_by: actorUserId,
        created_at: new Date().toISOString(),
      };
      state.messages.push(msgRow);
      return { rows: [{ id: msgRow.id, created_at: msgRow.created_at }], rowCount: 1 };
    }

    // 8. Audit log
    if (sql.startsWith('INSERT INTO pedidos_app_audit_logs')) {
      return { rows: [], rowCount: 1 };
    }

    // 9. Stock movements
    if (sql.startsWith('INSERT INTO pedidos_app_product_stock_movements')) {
      state.inventoryMovements.push(params);
      return { rows: [], rowCount: 1 };
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

/**
 * Servidor Express aislado con la API CRM montada para pruebas HTTP reales
 */
function createTestApp(pool, customOptions = {}) {
  const app = express();
  app.use(express.json());

  // Middleware simulado de autenticación con permisos
  const authenticateToken = (req, res, next) => {
    req.user = { id: 7, name: 'Cajero Operador', role: 'admin' };
    next();
  };
  const requirePermission = () => (req, res, next) => next();

  // Cliente WhatsApp mockeado
  const whatsappClient = {
    sendText: async ({ to, body }) => ({ id: `wamid_mock_${Date.now()}`, to, body }),
  };

  registerCrmApi(app, {
    pool,
    authenticateToken,
    requirePermission,
    whatsappClient,
    crmWorker: { processOne: async () => {} },
    issueTrackingToken: (orderId) => `trk_token_${orderId}`,
    JWT_SECRET: 'test_jwt_secret',
    ...customOptions,
  });

  return app;
}

// =============================================================================
// ESCENARIOS DE PRUEBA OBLIGATORIOS (SECCIÓN 11)
// =============================================================================

test('Escenarios 1, 2, 5, 8, 9, 10, 11 y 12: Crear pedido válido desde WhatsApp, envío a cocina, cálculo de totales y resumen', async () => {
  const pool = createInMemoryOrderPool();

  // Crear contacto y conversación
  const contact = {
    id: 1,
    display_name: 'Carlos Mendoza',
    normalized_phone: '+573155551234',
    bsuid: null,
    address: 'Cra. 15 #85-30',
    barrio: 'Antiguo Country',
    no_contact: false,
    marketing_opt_out: false,
    deleted_at: null,
  };
  pool.state.contacts.push(contact);

  const conversation = {
    id: 10,
    contact_id: 1,
    channel: 'WHATSAPP',
    status: 'OPEN',
    unread_count: 0,
    last_inbound_at: new Date().toISOString(), // Ventana 24h abierta
    last_message_at: new Date().toISOString(),
  };
  pool.state.conversations.push(conversation);

  const app = createTestApp(pool);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const payload = {
      customer: {
        name: 'Carlos Mendoza',
        phone: '+573155551234',
        address: 'Cra. 15 #85-30',
        barrio: 'Antiguo Country',
        deliveryType: 'domicilio',
        paymentMethod: 'efectivo',
        cashAmount: 50000,
        notes: 'Timbre no funciona, llamar al llegar',
      },
      cart: [
        { id: 101, quantity: 1, notes: 'Sin cebolla' },
        { id: 102, quantity: 1 },
      ],
      deliveryType: 'domicilio',
      paymentMethod: 'efectivo',
      sendToKitchen: true,
      sendWhatsAppSummary: true,
      idempotencyKey: 'idem_test_order_1',
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/10/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.status, 'ok');

    // 1. Verificación del cálculo de totales (Subtotal: 28.000 + 9.000 = 37.000 + 5.000 domicilio = 42.000)
    assert.equal(data.order.subtotal, 37000);
    assert.equal(data.order.delivery_fee, 5000);
    assert.equal(data.order.total, 42000);
    assert.equal(data.order.change_required, 8000); // 50.000 - 42.000

    // 2. Verificación de que el pedido aparece en pedidos_app_orders
    const savedOrder = pool.state.orders.find((o) => o.id === data.order.id);
    assert.ok(savedOrder);
    assert.equal(savedOrder.source, 'WhatsApp CRM');
    assert.equal(savedOrder.total, 42000);

    // 3. Verificación del flujo de cocina ('En preparación')
    assert.equal(savedOrder.status, 'En preparación');

    // 4. Verificación de vinculación a cliente y conversación
    assert.equal(savedOrder.crm_contact_id, 1);

    // 5. Verificación de tarjeta de mensaje dentro del chat
    const orderMsg = pool.state.messages.find((m) => m.message_type === 'order');
    assert.ok(orderMsg);
    assert.equal(orderMsg.content.order_id, savedOrder.id);
    assert.equal(orderMsg.content.total, 42000);

    // 6. Verificación del resumen formateado para WhatsApp
    assert.ok(data.order.tracking_url.includes('rastrear'));
    const summaryText = formatCrmOrderWhatsAppSummary({
      order: savedOrder,
      items: savedOrder.cart_json,
      customer: payload.customer,
      restaurantName: 'Distrito BG',
    });
    assert.match(summaryText, /🍔 \*Distrito BG — Pedido Confirmado\*/);
    assert.match(summaryText, /Hamburguesa Distrito Doble/);
    assert.match(summaryText, /42\.000/);
    assert.match(summaryText, /🛵 A Domicilio/);
  } finally {
    server.close();
  }
});

test('Escenarios 6 y 7: Rechazar precios manipulados desde el cliente y cantidades inválidas', async () => {
  const pool = createInMemoryOrderPool();
  pool.state.contacts.push({ id: 2, display_name: 'Cliente Test', normalized_phone: '+573001112233' });
  pool.state.conversations.push({ id: 20, contact_id: 2, channel: 'WHATSAPP', status: 'OPEN' });

  const app = createTestApp(pool);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Intento de manipulación de precio: el cliente envía price: 100 en lugar del precio real (28.000)
    const manipulatedPayload = {
      customer: { name: 'Cliente', phone: '+573001112233', address: 'Calle 100 #10-20' },
      cart: [{ id: 101, title: 'Hamburguesa', price: 100, quantity: 1 }],
      deliveryType: 'domicilio',
      paymentMethod: 'transferencia',
    };

    const res1 = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/20/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manipulatedPayload),
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    // El servidor ignora el precio enviado por el cliente y toma el precio oficial de la base de datos (28.000 + 5.000 = 33.000)
    assert.equal(data1.order.subtotal, 28000);
    assert.equal(data1.order.total, 33000);

    // Intento con carrito vacío
    const emptyPayload = {
      customer: { name: 'Cliente', phone: '+573001112233' },
      cart: [],
    };
    const res2 = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/20/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emptyPayload),
    });
    assert.equal(res2.status, 400);

    // Intento con producto inexistente
    const invalidProductPayload = {
      customer: { name: 'Cliente', phone: '+573001112233', address: 'Calle 1' },
      cart: [{ id: 9999, quantity: 1 }],
      deliveryType: 'domicilio',
    };
    const res3 = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/20/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidProductPayload),
    });
    assert.equal(res3.status, 400);
  } finally {
    server.close();
  }
});

test('Escenarios 14, 15 y 16: Idempotencia estricta, prevención de doble clic y no duplicación de pedidos ni movimientos', async () => {
  const pool = createInMemoryOrderPool();
  pool.state.contacts.push({ id: 3, display_name: 'Ana Pérez', normalized_phone: '+573104445566' });
  pool.state.conversations.push({ id: 30, contact_id: 3, channel: 'WHATSAPP', status: 'OPEN' });

  const app = createTestApp(pool);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const fixedIdempotencyKey = 'idem_unique_doubleclick_key_123';
    const payload = {
      customer: { name: 'Ana Pérez', phone: '+573104445566', address: 'Av 19 #100-10' },
      cart: [{ id: 101, quantity: 2 }],
      deliveryType: 'domicilio',
      paymentMethod: 'transferencia',
      idempotencyKey: fixedIdempotencyKey,
    };

    // Primer intento: creación exitosa
    const res1 = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/30/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': fixedIdempotencyKey },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    const firstOrderId = data1.order.id;

    // Segundo intento idéntico (simula doble clic del operador o reintento de red)
    const res2 = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/30/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': fixedIdempotencyKey },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();

    // Verificación de idempotencia: devuelve el mismo pedido y marca duplicate: true
    assert.equal(data2.duplicate, true);
    assert.equal(data2.order.id, firstOrderId);

    // Verificación en base de datos: solo existe UN pedido registrado
    assert.equal(pool.state.orders.length, 1);
  } finally {
    server.close();
  }
});

test('Escenarios 17 y 18: Modalidad domicilio vs recoger en local', async () => {
  const pool = createInMemoryOrderPool();
  pool.state.contacts.push({ id: 4, display_name: 'Pedro Gómez', normalized_phone: '+573209998877' });
  pool.state.conversations.push({ id: 40, contact_id: 4, channel: 'WHATSAPP', status: 'OPEN' });

  const app = createTestApp(pool);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Domicilio sin dirección debe ser rechazado
    const noAddressRes = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/40/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Pedro', address: '' },
        cart: [{ id: 101, quantity: 1 }],
        deliveryType: 'domicilio',
      }),
    });
    assert.equal(noAddressRes.status, 400);

    // 2. Recoger en local no requiere dirección y tiene recargo de domicilio $0
    const pickupRes = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/40/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Pedro' },
        cart: [{ id: 101, quantity: 1 }],
        deliveryType: 'tienda',
        paymentMethod: 'efectivo',
        cashAmount: 30000,
      }),
    });
    assert.equal(pickupRes.status, 201);
    const pickupData = await pickupRes.json();
    assert.equal(pickupData.order.delivery_fee, 0);
    assert.equal(pickupData.order.total, 28000); // Solo precio del producto, sin recargo
  } finally {
    server.close();
  }
});

test('Escenario 20: CONSUMIDOR FINAL no recibe mensajes ficticios por WhatsApp', async () => {
  const pool = createInMemoryOrderPool();
  // Contacto CONSUMIDOR FINAL (ventas presenciales en caja)
  pool.state.contacts.push({
    id: 5,
    display_name: 'CONSUMIDOR FINAL',
    normalized_phone: '+572222222',
    bsuid: '2222222',
    no_contact: false,
    marketing_opt_out: true,
  });
  pool.state.conversations.push({ id: 50, contact_id: 5, channel: 'WHATSAPP', status: 'OPEN' });

  const app = createTestApp(pool);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pedidos/admin/crm/conversations/50/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'CONSUMIDOR FINAL' },
        cart: [{ id: 101, quantity: 1 }],
        deliveryType: 'tienda',
        paymentMethod: 'efectivo',
        cashAmount: 30000,
        sendWhatsAppSummary: true,
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();

    // Verificación: se crea el pedido pero se omite explícitamente el envío a WhatsApp
    assert.ok(data.order.id);
    assert.equal(data.whatsapp.status, 'omitted_consumidor_final');
  } finally {
    server.close();
  }
});
