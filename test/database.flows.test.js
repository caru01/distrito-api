const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');
const { authorizeTrackingAccess, issueTrackingToken } = require('../src/tracking');
const { getDashboardSnapshot } = require('../src/dashboard');

test('dashboard agrega la operación sin descargar colecciones completas', async () => {
  const pool = createPool({ max: 1 });
  try {
    const snapshot = await getDashboardSnapshot(pool, async () => ({
      isOpen: true,
      statusText: 'Prueba de contrato',
      currentSchedule: null,
    }));
    assert.equal(typeof snapshot.orders.today, 'number');
    assert.equal(typeof snapshot.products.active, 'number');
    assert.equal(typeof snapshot.inventory.critical, 'number');
    assert.ok(Array.isArray(snapshot.recentOrders));
    assert.ok(snapshot.recentOrders.length <= 6);
    assert.ok(Array.isArray(snapshot.topProducts));
    assert.equal(snapshot.schedule.isOpen, true);
  } finally {
    await pool.end();
  }
});

test('horarios acepta actualización y excepciones con parámetros', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      'UPDATE pedidos_app_horarios SET is_active=$1, open_time=$2, close_time=$3 WHERE day_of_week=$4 RETURNING id',
      [true, '18:00', '22:00', 'Lunes']
    );
    assert.equal(updated.rowCount, 1);

    const inserted = await client.query(
      `INSERT INTO pedidos_app_horarios_exceptions
       (exception_date, description, is_closed, open_time, close_time)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (exception_date) DO UPDATE SET description=EXCLUDED.description
       RETURNING id`,
      ['2999-12-31', 'Prueba transaccional', true, null, null]
    );
    assert.equal(inserted.rowCount, 1);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('compras, lotes y movimientos comparten identificadores compatibles', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ingredients } = await client.query(`
      INSERT INTO pedidos_app_inventory
      (name, sku, purchase_unit, consumption_unit, conversion_factor)
      VALUES ($1,$2,'kg','g',1000) RETURNING id
    `, [`Prueba ${Date.now()}`, `TST-${Date.now()}`]);
    const inventoryId = ingredients[0].id;

    const { rows: purchases } = await client.query(
      `INSERT INTO pedidos_app_purchases (invoice_number, total_amount)
       VALUES ('TEST-ROLLBACK', 1000) RETURNING id`
    );
    const purchaseId = purchases[0].id;

    const { rows: items } = await client.query(`
      INSERT INTO pedidos_app_purchase_items
      (purchase_id, inventory_id, quantity, unit_cost, total_cost, lot_code)
      VALUES ($1,$2,1,1,1000,'TEST-ROLLBACK') RETURNING id
    `, [purchaseId, inventoryId]);

    const { rows: lots } = await client.query(`
      INSERT INTO pedidos_app_inventory_lots
      (inventory_id, purchase_item_id, lot_code, source_quantity, source_unit,
       initial_quantity, available_quantity, unit_cost)
      VALUES ($1,$2,'TEST-ROLLBACK',1,'kg',1000,1000,1) RETURNING id
    `, [inventoryId, items[0].id]);

    const movement = await client.query(`
      INSERT INTO pedidos_app_inventory_movements
      (inventory_id, lot_id, movement_type, quantity, unit_cost, balance_after,
       reference_type, reference_id, created_by)
      VALUES ($1,$2,'Compra',1000,1,1000,'Compra',$3,'Prueba') RETURNING id
    `, [inventoryId, lots[0].id, purchaseId]);
    assert.equal(movement.rowCount, 1);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('pedido acepta tipo de entrega y cálculo booleano con parámetros separados', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`
      INSERT INTO pedidos_app_orders
        (customer_name, customer_phone, address, barrio, delivery_type, payment_method,
         total, delivery_fee, delivery_latitude, delivery_longitude, delivery_place_id)
      VALUES ($1, $2, $3, $4, $5, $6, 0,
        CASE WHEN $7::boolean THEN 5000 ELSE 0 END, $8, $9, $10)
      RETURNING delivery_type, delivery_fee, delivery_latitude, delivery_longitude
    `, ['Prueba geolocalizada', '570000000000', 'Cra 19 #15-34', 'Centro', 'domicilio', 'efectivo', true, 10.468235, -73.253628, 'place-test']);
    assert.equal(inserted.rows[0].delivery_type, 'domicilio');
    assert.equal(inserted.rows[0].delivery_fee, 5000);
    assert.equal(Number(inserted.rows[0].delivery_latitude), 10.468235);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('el enlace firmado sigue el pedido y caduca después de finalizar', async () => {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();
  const secret = 'tracking-test-secret-with-enough-entropy';
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO pedidos_app_orders
        (customer_name, customer_phone, delivery_type, payment_method, total, status)
      VALUES ('Cliente seguimiento', '573001112233', 'domicilio', 'efectivo', 0, 'Nuevo')
      RETURNING id
    `);
    const orderId = rows[0].id;
    const token = issueTrackingToken(orderId, secret);
    const access = await authorizeTrackingAccess(client, { orderId, token, secret });
    assert.equal(access.method, 'token');
    const codeAccess = await authorizeTrackingAccess(client, { orderId, code: '2233', secret });
    assert.equal(codeAccess.method, 'code');

    await client.query(`
      UPDATE pedidos_app_orders
      SET status = 'Entregado', delivery_status = 'Entregado',
          delivery_completed_at = NOW() - INTERVAL '20 minutes', updated_at = NOW()
      WHERE id = $1
    `, [orderId]);
    await assert.rejects(
      authorizeTrackingAccess(client, { orderId, token, secret }),
      (error) => error.code === 'TRACKING_LINK_FINISHED' && error.statusCode === 410
    );
    const manualAccess = await authorizeTrackingAccess(client, { orderId, phone: '3001112233', secret });
    assert.equal(manualAccess.method, 'phone');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

async function createTestDriver(client, suffix) {
  const { rows } = await client.query(`
    INSERT INTO pedidos_app_users (username, password_hash, status)
    VALUES ($1, 'test-only-hash', 'Activo') RETURNING id
  `, [`delivery-flow-${suffix}`]);
  await client.query(`
    INSERT INTO pedidos_app_delivery_profiles
      (user_id, availability_status, current_latitude, current_longitude, last_location_at)
    VALUES ($1, 'Ocupado', 10.468235, -73.253628, NOW())
  `, [rows[0].id]);
  return rows[0].id;
}

async function createTestCompany(client, suffix) {
  const { rows } = await client.query(`
    INSERT INTO pedidos_app_delivery_companies
      (name, phone, default_fee, estimated_delivery_minutes)
    VALUES ($1, '3000000000', 8000, 45) RETURNING id
  `, [`Operador prueba ${suffix}`]);
  return rows[0].id;
}

test('escenario 1: domiciliario propio conserva GPS real', async () => {
  const pool = createPool({ max: 1 }); const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const suffix = `${Date.now()}-${Math.random()}`;
    const driverId = await createTestDriver(client, suffix);
    const { rows } = await client.query(`
      INSERT INTO pedidos_app_orders
        (customer_name,customer_phone,delivery_type,payment_method,total,status,
         delivery_status,delivery_provider_type,delivery_user_id,delivery_accepted_at)
      VALUES ('GPS propio',$1,'domicilio','efectivo',50000,'En camino','En camino','own',$2,NOW()-INTERVAL '1 second')
      RETURNING id
    `, [`57${String(Date.now()).slice(-10)}`, driverId]);
    const tracking = await client.query(`
      SELECT order_data.delivery_provider_type, profile.current_latitude, profile.current_longitude
      FROM pedidos_app_orders order_data
      JOIN pedidos_app_delivery_profiles profile ON profile.user_id=order_data.delivery_user_id
      WHERE order_data.id=$1 AND profile.last_location_at >= order_data.delivery_accepted_at
    `, [rows[0].id]);
    assert.equal(tracking.rows[0].delivery_provider_type, 'own');
    assert.equal(Number(tracking.rows[0].current_latitude), 10.468235);
    await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
});

test('escenario 2: empresa externa avanza por estados y no crea GPS', async () => {
  const pool = createPool({ max: 1 }); const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const suffix = `${Date.now()}-${Math.random()}`;
    const companyId = await createTestCompany(client, suffix);
    const inserted = await client.query(`
      INSERT INTO pedidos_app_orders
        (customer_name,customer_phone,delivery_type,payment_method,total,status,delivery_status,
         delivery_fee,delivery_provider_type,external_delivery_company_id,external_delivery_cost,external_assigned_at)
      VALUES ('Externo manual',$1,'domicilio','efectivo',56000,'Asignado externo','Asignado externo',6000,'external_manual',$2,8000,NOW())
      RETURNING id
    `, [`56${String(Date.now()).slice(-10)}`, companyId]);
    const orderId = inserted.rows[0].id;
    for (const [from, to] of [['Asignado externo','Entregado al operador externo'],['Entregado al operador externo','En camino'],['En camino','Entregado']]) {
      const updated = await client.query('UPDATE pedidos_app_orders SET status=$1,delivery_status=$1 WHERE id=$2 AND delivery_status=$3 RETURNING id', [to, orderId, from]);
      assert.equal(updated.rowCount, 1);
    }
    const result = await client.query(`
      SELECT delivery_provider_type, delivery_user_id, delivery_fee-external_delivery_cost AS margin,
             (SELECT COUNT(*)::int FROM pedidos_app_delivery_locations WHERE order_id=orders.id) AS gps_points
      FROM pedidos_app_orders orders WHERE id=$1
    `, [orderId]);
    assert.equal(result.rows[0].delivery_provider_type, 'external_manual');
    assert.equal(result.rows[0].delivery_user_id, null);
    assert.equal(Number(result.rows[0].margin), -2000);
    assert.equal(result.rows[0].gps_points, 0);
    await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
});

test('escenario 3: pedido propio pendiente se reasigna a una empresa externa', async () => {
  const pool = createPool({ max: 1 }); const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const suffix = `${Date.now()}-${Math.random()}`;
    const driverId = await createTestDriver(client, suffix);
    const companyId = await createTestCompany(client, suffix);
    const inserted = await client.query(`
      INSERT INTO pedidos_app_orders
        (customer_name,customer_phone,delivery_type,payment_method,total,status,delivery_status,
         delivery_provider_type,delivery_user_id)
      VALUES ('Reasignación',$1,'domicilio','efectivo',50000,'Listo','Pendiente','own',$2)
      RETURNING id
    `, [`55${String(Date.now()).slice(-10)}`, driverId]);
    const { rows } = await client.query(`
      UPDATE pedidos_app_orders SET status='Asignado externo',delivery_status='Asignado externo',
        delivery_provider_type='external_manual',delivery_user_id=NULL,
        external_delivery_company_id=$1,external_delivery_cost=8000,external_assigned_at=NOW()
      WHERE id=$2 AND status='Listo' AND delivery_status='Pendiente'
      RETURNING delivery_provider_type,delivery_user_id,external_delivery_company_id
    `, [companyId, inserted.rows[0].id]);
    assert.equal(rows[0].delivery_provider_type, 'external_manual');
    assert.equal(rows[0].delivery_user_id, null);
    assert.equal(rows[0].external_delivery_company_id, companyId);
    await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
});
