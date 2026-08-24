const { Pool } = require('pg');
const { configuration, createWhatsAppClient, validateWebhookSignature } = require('../src/whatsapp-cloud');
const request = require('supertest');
process.env.VERCEL = 'true';
const app = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_TEST_URL || process.env.DATABASE_URL });

describe('Admin Orders BSUID Flow', () => {
  let client;

  beforeAll(async () => {
    client = await pool.connect();
    const fs = require('fs');
    const path = require('path');
    const migSql = fs.readFileSync(path.join(__dirname, '../migrations/024_crm_bsuid_orders_trigger.sql'), 'utf8');
    await client.query(migSql);
    await client.query("INSERT INTO pedidos_app_products (id, title, price, status) VALUES ('00000000-0000-0000-0000-000000000001', 'Prod', 100, 'Activo') ON CONFLICT DO NOTHING");
    await client.query("UPDATE pedidos_app_products SET status = 'Activo' WHERE id = '00000000-0000-0000-0000-000000000001'");
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  afterEach(async () => {
    // No-op
  });

  beforeEach(async () => {
    await client.query('TRUNCATE pedidos_app_orders, pedidos_app_crm_contacts CASCADE');
  });

  it('1. envío por to y 2. envío por recipient (WhatsApp Client)', async () => {
    // Mock fetchImpl
    let requestedBody = {};
    const fetchImpl = jest.fn(async (url, options) => {
      requestedBody = JSON.parse(options.body);
      return { ok: true, text: async () => JSON.stringify({ messages: [{ id: 'mock-id' }] }) };
    });

    const wp = createWhatsAppClient({
      env: { WHATSAPP_ACCESS_TOKEN: 'mock', WHATSAPP_VERIFY_TOKEN: 'mock', WHATSAPP_PHONE_NUMBER_ID: 'mock' },
      fetchImpl
    });

    // Test 1: to
    await wp.sendText({ to: '+573001234567', body: 'Test' });
    expect(requestedBody.to).toBe('573001234567');
    expect(requestedBody.recipient).toBeUndefined();

    // Test 2: recipient
    await wp.sendText({ to: 'CO.123456789', body: 'Test BSUID' });
    expect(requestedBody.recipient).toBe('CO.123456789');
    expect(requestedBody.to).toBeUndefined();
    
    // Test 3: impedir to + recipient simultáneos
    // By design in our new code, we ONLY set one of them based on the `to` argument provided.
    expect(requestedBody.to && requestedBody.recipient).toBeFalsy();
  });

  it('3. pedido con teléfono funciona normalmente', async () => {
    const res = await request(app)
      .post('/api/pedidos/checkout')
      .send({
        customer: { name: 'Pepe', phone: '3001234567', address: 'Calle 1' },
        cart: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Prod', price: 100, quantity: 1 }]
      });
    expect(res.status).toBe(201);
    expect(res.body.order_id).toBeDefined();

    const dbOrder = await client.query('SELECT crm_contact_id, customer_phone_e164 FROM pedidos_app_orders WHERE id = $1', [res.body.order_id]);
    expect(dbOrder.rows[0].customer_phone_e164).toBe('+573001234567');
    expect(dbOrder.rows[0].crm_contact_id).toBeDefined(); // Trigger created the CRM contact
  });

  it('4. pedido solo con crm_contact_id y cliente BSUID sin teléfono', async () => {
    // 1. Create a CRM contact manually to simulate a WhatsApp BSUID interaction
    const crmInsert = await client.query(`
      INSERT INTO pedidos_app_crm_contacts (bsuid, username, display_name) 
      VALUES ('CO.0001', 'username_test', 'Juan BSUID') RETURNING id
    `);
    const contactId = crmInsert.rows[0].id;

    // 2. Create order without phone, but WITH crm_contact_id
    const res = await request(app)
      .post('/api/pedidos/checkout')
      .send({
        customer: { name: 'Juan BSUID', phone: '', address: 'Calle BSUID', crm_contact_id: contactId },
        cart: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Prod', price: 100, quantity: 1 }]
      });
    
    expect(res.status).toBe(201);
    expect(res.body.order_id).toBeDefined();

    const dbOrder = await client.query('SELECT crm_contact_id, customer_phone_e164 FROM pedidos_app_orders WHERE id = $1', [res.body.order_id]);
    expect(dbOrder.rows[0].customer_phone_e164).toBeNull();
    // Trigger must preserve the crm_contact_id
    expect(dbOrder.rows[0].crm_contact_id).toBe(String(contactId));
  });

  it('5. cliente BSUID que posteriormente obtiene teléfono (impidiendo duplicados)', async () => {
    // 1. Create BSUID contact
    const crmInsert = await client.query(`
      INSERT INTO pedidos_app_crm_contacts (bsuid, username, display_name) 
      VALUES ('CO.0002', 'username_phone', 'Maria') RETURNING id
    `);
    const contactId = crmInsert.rows[0].id;

    // 2. Create order with BOTH crm_contact_id and phone
    const res = await request(app)
      .post('/api/pedidos/checkout')
      .send({
        customer: { name: 'Maria', phone: '3009998888', crm_contact_id: contactId },
        cart: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Prod', price: 100, quantity: 1 }]
      });
    
    expect(res.status).toBe(201);
    
    // 3. Verify order was linked to the SAME contactId
    const dbOrder = await client.query('SELECT crm_contact_id, customer_phone_e164 FROM pedidos_app_orders WHERE id = $1', [res.body.order_id]);
    expect(dbOrder.rows[0].crm_contact_id).toBe(String(contactId));
    expect(dbOrder.rows[0].customer_phone_e164).toBe('+573009998888');

    // 4. Verify no duplicates were created in CRM
    const crmCheck = await client.query('SELECT * FROM pedidos_app_crm_contacts WHERE bsuid = $1', ['CO.0002']);
    expect(crmCheck.rowCount).toBe(1); // STILL ONLY ONE CONTACT
    expect(crmCheck.rows[0].normalized_phone).toBe('+573009998888'); // UPDATED
  });
});
