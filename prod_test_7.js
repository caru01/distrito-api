const { Pool } = require('pg');
require('dotenv').config();
const assert = require('assert');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runProdTest() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const resPhone = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, normalized_phone, source, status) VALUES ('PROD TEST PHONE', '+573999999999', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idPhone = resPhone.rows[0].id;

    const resBsuid = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, bsuid, source, status) VALUES ('PROD TEST BSUID', 'CO.PROD_TEST_999', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idBsuid = resBsuid.rows[0].id;

    const resOrder = await client.query(
      "INSERT INTO pedidos_app_orders (customer_name, customer_phone, crm_contact_id) VALUES ('PROD TEST', '3999999999', " + idBsuid + ") RETURNING id, crm_contact_id"
    );
    const order = resOrder.rows[0];

    assert.strictEqual(String(order.crm_contact_id), String(idPhone), 'Order reparented to phone contact');
    
    const checkTarget = await client.query("SELECT bsuid FROM pedidos_app_crm_contacts WHERE id = " + idPhone);
    assert.strictEqual(checkTarget.rows[0].bsuid, 'CO.PROD_TEST_999', 'BSUID transferred to phone contact');

    const checkSource = await client.query("SELECT deleted_at, status FROM pedidos_app_crm_contacts WHERE id = " + idBsuid);
    assert.ok(checkSource.rows[0].deleted_at !== null, 'Source soft deleted');
    
    console.log('Isolated production test PASSED.');
  } catch (err) {
    console.error('Isolated production test FAILED:', err);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
runProdTest().catch(console.error);
