const { Pool } = require('pg');
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runTests() {
  const client = await pool.connect();
  let totalPassed = 0;
  
  const runTest = async (name, fn) => {
    try {
      await client.query('SAVEPOINT test_savepoint');
      await fn();
      console.log('[PASS] ' + name);
      totalPassed++;
    } catch (err) {
      console.error('[FAIL] ' + name + ':', err.message);
      await client.query('ROLLBACK TO test_savepoint');
      throw err;
    }
  };

  try {
    await client.query('BEGIN');
    
    // Apply migration temporarily
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/024_orders_bsuid_support.sql'), 'utf8');
    const safeSql = sql.replace(/BEGIN;/g, '').replace(/COMMIT;/g, '');
    await client.query(safeSql);

    const createContact = async (data) => {
      const res = await client.query(
        "INSERT INTO pedidos_app_crm_contacts (display_name, normalized_phone, bsuid, username, source, status) VALUES ($1, $2, $3, $4, 'TEST', 'NUEVO_CONTACTO') RETURNING id",
        [data.name, data.phone || null, data.bsuid || null, data.username || null]
      );
      return res.rows[0].id;
    };

    const insertOrder = async (order) => {
      const res = await client.query(
        "INSERT INTO pedidos_app_orders (customer_name, customer_phone, crm_contact_id, source, total, delivery_type, payment_method) VALUES ($1, $2, $3, 'MANUAL', 100, 'domicilio', 'efectivo') RETURNING id, crm_contact_id, customer_phone_e164",
        [order.customer_name, order.customer_phone || null, order.crm_contact_id || null]
      );
      return res.rows[0];
    };

    await runTest('Prueba 11: BSUID + telefono perteneciente a otro contacto', async () => {
      const idPhone = await createContact({ name: 'User Phone', phone: '+573000000011' });
      const idBsuid = await createContact({ name: 'User BSUID', bsuid: 'CO.1111' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000011', crm_contact_id: idBsuid });
      assert.strictEqual(order.crm_contact_id, idPhone);
      const { rows } = await client.query('SELECT bsuid, deleted_at, status FROM pedidos_app_crm_contacts WHERE id IN ($1, $2) ORDER BY id', [idPhone, idBsuid]);
      const cPhone = rows.find(r => r.bsuid === 'CO.1111');
      const cBsuid = rows.find(r => r.status === 'INACTIVO');
      assert.ok(cPhone, 'Phone contact should inherit BSUID');
      assert.ok(cBsuid && cBsuid.deleted_at !== null, 'Original BSUID soft deleted');
    });

    await runTest('Prueba 12: BSUID + telefono nuevo', async () => {
      const idBsuid = await createContact({ name: 'User BSUID 2', bsuid: 'CO.2222' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000012', crm_contact_id: idBsuid });
      assert.strictEqual(order.crm_contact_id, idBsuid);
      const { rows } = await client.query('SELECT normalized_phone FROM pedidos_app_crm_contacts WHERE id = $1', [idBsuid]);
      assert.strictEqual(rows[0].normalized_phone, '+573000000012');
    });

    await runTest('Prueba 13: BSUID mismo telefono', async () => {
      const idContact = await createContact({ name: 'User BSUID 3', bsuid: 'CO.3333', phone: '+573000000013' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000013', crm_contact_id: idContact });
      assert.strictEqual(order.crm_contact_id, idContact);
    });

    await runTest('Prueba 14: BSUID telefono diferente', async () => {
      const idContact = await createContact({ name: 'User BSUID 4', bsuid: 'CO.4444', phone: '+573000000014' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000015', crm_contact_id: idContact });
      assert.strictEqual(order.crm_contact_id, idContact);
    });

    await runTest('Prueba 15: sin telefono ni BSUID', async () => {
      // Simulate order with no phone and no crm_contact_id
      const order = await insertOrder({ customer_name: 'Test', customer_phone: null, crm_contact_id: null });
      assert.strictEqual(order.crm_contact_id, null);
    });

    await runTest('Prueba 16: username en conflicto', async () => {
      const idPhone = await createContact({ name: 'Phone User', phone: '+573000000016', username: 'existing_user' });
      const idBsuid = await createContact({ name: 'Bsuid User', bsuid: 'CO.16', username: 'new_user' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000016', crm_contact_id: idBsuid });
      assert.strictEqual(order.crm_contact_id, idPhone);
      const { rows } = await client.query('SELECT username FROM pedidos_app_crm_contacts WHERE id = $1', [idPhone]);
      assert.strictEqual(rows[0].username, 'existing_user');
    });

    await runTest('Prueba 17: Ambos contactos tienen BSUID', async () => {
      const idPhone = await createContact({ name: 'Phone User', phone: '+573000000017', bsuid: 'CO.17A' });
      const idBsuid = await createContact({ name: 'Bsuid User', bsuid: 'CO.17B' });
      const order = await insertOrder({ customer_name: 'Test', customer_phone: '3000000017', crm_contact_id: idBsuid });
      assert.strictEqual(order.crm_contact_id, idPhone);
      const { rows } = await client.query('SELECT bsuid FROM pedidos_app_crm_contacts WHERE id = $1', [idPhone]);
      assert.strictEqual(rows[0].bsuid, 'CO.17A');
    });

    await runTest('Prueba 19: migra historial de interacciones', async () => {
      const idPhone = await createContact({ name: 'Phone User', phone: '+573000000019' });
      const idBsuid = await createContact({ name: 'Bsuid User', bsuid: 'CO.19' });
      
      await client.query("INSERT INTO pedidos_app_crm_activities (contact_id, activity_type, summary) VALUES ($1, 'TEST', 'Actividad')", [idBsuid]);
      
      await insertOrder({ customer_name: 'Test', customer_phone: '3000000019', crm_contact_id: idBsuid });
      
      const activities = await client.query('SELECT * FROM pedidos_app_crm_activities WHERE contact_id = $1 AND activity_type = $2', [idPhone, 'TEST']);
      assert.strictEqual(activities.rows.length, 1);
    });

    await runTest('Prueba 20: fusion idempotente', async () => {
      const idPhone = await createContact({ name: 'Phone User', phone: '+573000000020' });
      const idBsuid = await createContact({ name: 'Bsuid User', bsuid: 'CO.20' });
      await insertOrder({ customer_name: 'Test', customer_phone: '3000000020', crm_contact_id: idBsuid });
      await insertOrder({ customer_name: 'Test', customer_phone: '3000000020', crm_contact_id: idBsuid });
    });

    console.log('--- TODAS LAS PRUEBAS EN BASE DE DATOS PASARON ---');

  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
runTests().catch(e => { console.error(e); process.exit(1); });
