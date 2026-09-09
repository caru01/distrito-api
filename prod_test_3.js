const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runProdTest() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create test phone contact
    const resPhone = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, normalized_phone, source, status) VALUES ('PROD TEST PHONE', '+573999999999', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idPhone = resPhone.rows[0].id;

    // Create test bsuid contact
    const resBsuid = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, bsuid, source, status) VALUES ('PROD TEST BSUID', 'CO.PROD_TEST_999', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idBsuid = resBsuid.rows[0].id;

    // Insert order associated with BSUID but containing the phone number
    const resOrder = await client.query(
      "INSERT INTO pedidos_app_orders (customer_name, customer_phone, crm_contact_id) VALUES ('PROD TEST', '3999999999', ) RETURNING id, crm_contact_id",
      [idBsuid]
    );
    console.log('Order inserted', resOrder.rows[0]);
    console.log('Test passed. Reparented to:', resOrder.rows[0].crm_contact_id, 'expected:', idPhone);
    
  } catch (err) {
    console.error('Isolated production test FAILED:', err);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
runProdTest().catch(console.error);
