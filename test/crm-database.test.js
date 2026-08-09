const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { compileSegment } = require('../src/crm/segments');

test('CRM vincula cliente y pedidos, actualiza métricas y atribuye una conversión', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const suffix = String(Date.now()).slice(-7);
    const localPhone = `31${suffix.padStart(8, '0')}`.slice(0, 10);
    const customer = await client.query(`
      INSERT INTO pedidos_app_customers(name,phone,marketing_opt_in)
      VALUES('Cliente CRM transaccional',$1,FALSE) RETURNING id,phone_e164
    `, [localPhone]);
    assert.match(customer.rows[0].phone_e164, /^\+57\d{10}$/);
    const contact = await client.query(`
      SELECT contact.* FROM pedidos_app_crm_contact_customers link
      JOIN pedidos_app_crm_contacts contact ON contact.id=link.contact_id WHERE link.customer_id=$1
    `, [customer.rows[0].id]);
    assert.equal(contact.rowCount, 1);
    assert.equal(contact.rows[0].marketing_opt_in, false, 'el backfill/alta no concede consentimiento');

    const firstOrder = await client.query(`
      INSERT INTO pedidos_app_orders(customer_name,customer_phone,delivery_type,payment_method,total,status,source)
      VALUES('Cliente CRM transaccional',$1,'recoger','Efectivo',20000,'Entregado','Web')
      RETURNING id,crm_contact_id,customer_phone_e164
    `, [localPhone]);
    assert.equal(Number(firstOrder.rows[0].crm_contact_id), Number(contact.rows[0].id));
    assert.equal(firstOrder.rows[0].customer_phone_e164, customer.rows[0].phone_e164);
    let metrics = await client.query('SELECT orders_count,total_spent,status FROM pedidos_app_crm_contacts WHERE id=$1', [contact.rows[0].id]);
    assert.deepEqual({ orders: metrics.rows[0].orders_count, spent: Number(metrics.rows[0].total_spent), status: metrics.rows[0].status }, { orders: 1, spent: 20000, status: 'CLIENTE_NUEVO' });

    await client.query(`
      INSERT INTO pedidos_app_orders(customer_name,customer_phone,delivery_type,payment_method,total,status,source)
      VALUES('Cliente CRM transaccional',$1,'recoger','Efectivo',30000,'Entregado','Web')
    `, [customer.rows[0].phone_e164]);
    metrics = await client.query('SELECT orders_count,total_spent,status FROM pedidos_app_crm_contacts WHERE id=$1', [contact.rows[0].id]);
    assert.deepEqual({ orders: metrics.rows[0].orders_count, spent: Number(metrics.rows[0].total_spent), status: metrics.rows[0].status }, { orders: 2, spent: 50000, status: 'CLIENTE_RECURRENTE' });

    const segment = compileSegment({ combinator: 'AND', rules: [{ field: 'orders_count', operator: 'gte', value: 2 }] }, { startAt: 2 });
    const segmentResult = await client.query(`SELECT id FROM pedidos_app_crm_contacts contact WHERE contact.id=$1 AND ${segment.sql}`, [contact.rows[0].id, ...segment.params]);
    assert.equal(segmentResult.rowCount, 1);

    const campaign = await client.query(`
      INSERT INTO pedidos_app_crm_campaigns(name,code,status,started_at)
      VALUES('Campaña CRM transaccional',$1,'RUNNING',NOW()) RETURNING id
    `, [`TEST_${Date.now()}`]);
    const recipient = await client.query(`
      INSERT INTO pedidos_app_crm_campaign_recipients(campaign_id,contact_id,status,sent_at)
      VALUES($1,$2,'SENT',NOW()-INTERVAL '1 hour') RETURNING id
    `, [campaign.rows[0].id, contact.rows[0].id]);
    const conversion = await client.query(`
      INSERT INTO pedidos_app_orders(customer_name,customer_phone,delivery_type,payment_method,total,status,source)
      VALUES('Cliente CRM transaccional',$1,'recoger','Efectivo',15000,'Entregado','WhatsApp') RETURNING id
    `, [localPhone]);
    const attribution = await client.query(`SELECT * FROM pedidos_app_crm_attributions WHERE order_id=$1`, [conversion.rows[0].id]);
    assert.equal(attribution.rowCount, 1);
    assert.equal(Number(attribution.rows[0].recipient_id), Number(recipient.rows[0].id));
    assert.equal(attribution.rows[0].attribution_type, 'ASSISTED');
    assert.equal(Number(attribution.rows[0].attributed_amount), 15000);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
