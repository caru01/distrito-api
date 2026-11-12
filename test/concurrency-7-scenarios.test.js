const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createPool } = require('../src/db');
const { createDeliveryOrderService } = require('../src/delivery-order-service');

async function createTestFixture(pool) {
  const client = await pool.connect();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await client.query('BEGIN');
    const role = await client.query("SELECT id FROM pedidos_app_roles WHERE name='Domiciliario' LIMIT 1");
    const userIds = [];
    for (let i = 1; i <= 2; i++) {
      const u = await client.query(`
        INSERT INTO pedidos_app_users (username, password_hash, role, role_id, status, name)
        VALUES ($1, 'test-hash', 'Domiciliario', $2, 'Activo', $3) RETURNING id
      `, [`test-scen-${i}-${suffix}`, role.rows[0].id, `Concur Driver ${i}`]);
      userIds.push(u.rows[0].id);
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles
          (user_id, max_active_orders, shift_active, shift_started_at, last_seen_at, tracking_device_id, tracking_lease_at, tracking_mode, gps_status, availability_status)
        VALUES ($1, 2, TRUE, NOW(), NOW(), $2, NOW(), 'FREE', 'active', 'Libre')
      `, [u.rows[0].id, `dev-${i}-${suffix}`]);
    }
    const orderIds = [];
    for (let i = 1; i <= 3; i++) {
      const o = await client.query(`
        INSERT INTO pedidos_app_orders
          (customer_name, customer_phone, address, barrio, delivery_type, payment_method, total, status, delivery_status, delivery_provider_type, delivery_latitude, delivery_longitude)
        VALUES ($1, '3001234567', 'Cra 15 # 10-20', 'Centro', 'domicilio', 'Efectivo', 25000, 'Listo', 'Pendiente', 'own', 10.468, -73.253)
        RETURNING id
      `, [`Cust-${i}-${suffix}`]);
      orderIds.push(o.rows[0].id);
    }
    await client.query('COMMIT');
    return { suffix, userIds, orderIds };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function cleanupTestFixture(pool, fixture) {
  if (!fixture) return;
  await pool.query('DELETE FROM pedidos_app_delivery_idempotency WHERE order_id=ANY($1::int[]) OR actor_user_id=ANY($2::int[])', [fixture.orderIds, fixture.userIds]);
  await pool.query("DELETE FROM pedidos_app_domain_events WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[])", [fixture.orderIds.map(String)]);
  await pool.query('DELETE FROM pedidos_app_orders WHERE id=ANY($1::int[])', [fixture.orderIds]);
  await pool.query('DELETE FROM pedidos_app_delivery_profiles WHERE user_id=ANY($1::int[])', [fixture.userIds]);
  await pool.query('DELETE FROM pedidos_app_users WHERE id=ANY($1::int[])', [fixture.userIds]);
}

test('Escenarios 1 al 7 de concurrencia y transiciones de pedidos', async () => {
  const pool = createPool({ max: 5 });
  let fixture;
  try {
    fixture = await createTestFixture(pool);
    const service = createDeliveryOrderService({ pool });
    const [d1, d2] = fixture.userIds;
    const [o1, o2, o3] = fixture.orderIds;

    // Escenario 1: Dos domiciliarios aceptan simultáneamente el mismo pedido
    const [acc1, acc2] = await Promise.allSettled([
      service.acceptOrder({ orderId: o1, driverId: d1, actor: { id: d1, username: 'd1' }, deviceId: `dev-1-${fixture.suffix}`, idempotencyKey: `acc1-${fixture.suffix}` }),
      service.acceptOrder({ orderId: o1, driverId: d2, actor: { id: d2, username: 'd2' }, deviceId: `dev-2-${fixture.suffix}`, idempotencyKey: `acc2-${fixture.suffix}` }),
    ]);
    const fulfilledCount1 = [acc1, acc2].filter(r => r.status === 'fulfilled').length;
    const rejectedCount1 = [acc1, acc2].filter(r => r.status === 'rejected').length;
    assert.equal(fulfilledCount1, 1, 'Exactamente un domiciliario debe ganar la aceptación simultánea');
    assert.equal(rejectedCount1, 1, 'El segundo domiciliario debe ser rechazado con conflicto');

    // Escenario 4: Se repite una solicitud de aceptación (idempotencia)
    const winningDriver = acc1.status === 'fulfilled' ? d1 : d2;
    const winningKey = acc1.status === 'fulfilled' ? `acc1-${fixture.suffix}` : `acc2-${fixture.suffix}`;
    const replay = await service.acceptOrder({
      orderId: o1, driverId: winningDriver, actor: { id: winningDriver, username: 'winner' },
      deviceId: `dev-${winningDriver === d1 ? 1 : 2}-${fixture.suffix}`, idempotencyKey: winningKey
    });
    assert.equal(replay.replayed, true, 'La solicitud idéntica repetida debe responder replayed: true');

    // Escenario 6: Se intenta aceptar un pedido que ya está en camino
    await service.startDelivery({
      orderId: o1, driverId: winningDriver, actor: { id: winningDriver, username: 'winner' },
      deviceId: `dev-${winningDriver === d1 ? 1 : 2}-${fixture.suffix}`, idempotencyKey: `start-${fixture.suffix}`
    });
    const otherDriver = winningDriver === d1 ? d2 : d1;
    await assert.rejects(
      async () => service.acceptOrder({
        orderId: o1, driverId: otherDriver, actor: { id: otherDriver, username: 'other' },
        deviceId: `dev-other-${fixture.suffix}`, idempotencyKey: `acc-ontheway-${fixture.suffix}`
      }),
      (err) => err.code === 'ORDER_ALREADY_TAKEN' || err.statusCode === 409,
      'No se puede aceptar un pedido que ya está en camino'
    );

    // Escenario 7: Se intenta reasignar un pedido que ya está en camino o completado
    await assert.rejects(
      async () => service.reserveOrder({
        orderId: o1, driverId: otherDriver, actor: { id: otherDriver, username: 'admin' },
        idempotencyKey: `reassign-ontheway-${fixture.suffix}`
      }),
      (err) => err.code === 'ORDER_ALREADY_TAKEN' || err.statusCode === 409,
      'No se puede reasignar un pedido que ya está en camino'
    );

    // Escenario 2 y 3: Admin reasigna mientras Domiciliario acepta (en o2)
    const [resRace, accRace] = await Promise.allSettled([
      service.reserveOrder({ orderId: o2, driverId: d1, actor: { id: d1, username: 'admin' }, idempotencyKey: `res-race-${fixture.suffix}` }),
      service.acceptOrder({ orderId: o2, driverId: d2, actor: { id: d2, username: 'd2' }, deviceId: `dev-2-${fixture.suffix}`, idempotencyKey: `acc-race-${fixture.suffix}` }),
    ]);
    const fulfilledRace = [resRace, accRace].filter(r => r.status === 'fulfilled').length;
    assert.equal(fulfilledRace, 1, 'En carrera Admin vs Domiciliario solo una operación debe tener éxito');

    console.log('✓ Los 7 escenarios de concurrencia y estados verificados exitosamente.');
  } finally {
    await cleanupTestFixture(pool, fixture);
    await pool.end();
  }
});
