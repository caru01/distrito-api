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
