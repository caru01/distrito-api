const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPool } = require('../src/db');
const { createDeliveryOrderService } = require('../src/delivery-order-service');
const { createDeliveryLocationService } = require('../src/delivery-location-service');

async function createFixture(pool) {
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const customerPhone = `3${crypto.randomInt(100000000, 1000000000)}`;
  const client = await pool.connect();
  const userIds = [];
  const orderIds = [];
  try {
    await client.query('BEGIN');
    const role = await client.query("SELECT id FROM pedidos_app_roles WHERE name IN ('Domiciliario','Repartidor') ORDER BY name LIMIT 1");
    assert.ok(role.rows[0], 'Debe existir el rol Domiciliario');
    for (let index = 1; index <= 2; index += 1) {
      const user = await client.query(`
        INSERT INTO pedidos_app_users
          (username,password_hash,role,role_id,status,name)
        VALUES ($1,'test-only','Domiciliario',$2,'Activo',$3)
        RETURNING id,username
      `, [`delivery-concurrency-${index}-${suffix}`, role.rows[0].id, `Prueba ${index}`]);
      userIds.push(user.rows[0].id);
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles
          (user_id,max_active_orders,shift_active,shift_started_at,last_seen_at,
           tracking_device_id,tracking_lease_at,tracking_mode,gps_status,availability_status)
        VALUES ($1,1,TRUE,NOW(),NOW(),$2,NOW(),'FREE','active','Libre')
      `, [user.rows[0].id, `test-device-${index}-${suffix}`]);
    }
    for (let index = 1; index <= 3; index += 1) {
      const order = await client.query(`
        INSERT INTO pedidos_app_orders
          (customer_name,customer_phone,address,barrio,delivery_type,payment_method,total,
           status,delivery_status,delivery_provider_type,delivery_latitude,delivery_longitude)
        VALUES ($1,$2,'Dirección de prueba','Centro','domicilio','Efectivo',10000,
                'Listo','Pendiente','own',10.468235,-73.253628)
        RETURNING id
      `, [`Cliente ${index} ${suffix}`,customerPhone]);
      orderIds.push(order.rows[0].id);
    }
    await client.query('COMMIT');
    return { suffix, userIds, orderIds, customerPhone };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool, fixture) {
  if (!fixture) return;
  await pool.query('DELETE FROM pedidos_app_delivery_idempotency WHERE order_id=ANY($1::int[]) OR actor_user_id=ANY($2::int[])', [fixture.orderIds, fixture.userIds]);
  await pool.query("DELETE FROM pedidos_app_domain_events WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[])", [fixture.orderIds.map(String)]);
  await pool.query('DELETE FROM pedidos_app_orders WHERE id=ANY($1::int[])', [fixture.orderIds]);
  const normalizedCustomerPhone = `+57${fixture.customerPhone}`;
  await pool.query('DELETE FROM pedidos_app_customers WHERE phone_e164=$1', [normalizedCustomerPhone]);
  await pool.query(`
    DELETE FROM pedidos_app_crm_contacts contact
    WHERE contact.normalized_phone=$1
      AND NOT EXISTS (SELECT 1 FROM pedidos_app_orders order_data WHERE order_data.crm_contact_id=contact.id)
      AND NOT EXISTS (SELECT 1 FROM pedidos_app_crm_contact_customers link WHERE link.contact_id=contact.id)
  `, [normalizedCustomerPhone]);
  await pool.query('DELETE FROM pedidos_app_users WHERE id=ANY($1::int[])', [fixture.userIds]);
}

test('dos domiciliarios concurrentes no pueden aceptar el mismo pedido', async () => {
  const pool = createPool({ max: 6 });
  let fixture;
  try {
    fixture = await createFixture(pool);
    const service = createDeliveryOrderService({ pool });
    const attempts = fixture.userIds.map((driverId, index) => service.acceptOrder({
      orderId: fixture.orderIds[0],
      driverId,
      actor: { id: driverId, username: `driver-${index + 1}` },
      deviceId: `test-device-${index + 1}-${fixture.suffix}`,
      idempotencyKey: `concurrency-${index + 1}-${fixture.suffix}`,
    }));
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ORDER_ALREADY_TAKEN');
    const persisted = await pool.query('SELECT delivery_status,delivery_user_id,version FROM pedidos_app_orders WHERE id=$1', [fixture.orderIds[0]]);
    assert.equal(persisted.rows[0].delivery_status, 'Aceptado');
    assert.ok(fixture.userIds.includes(persisted.rows[0].delivery_user_id));
    assert.equal(Number(persisted.rows[0].version), 2);
  } finally {
    await cleanup(pool, fixture);
    await pool.end();
  }
});

test('un mismo domiciliario no supera capacidad con dos aceptaciones simultáneas', async () => {
  const pool = createPool({ max: 6 });
  let fixture;
  try {
    fixture = await createFixture(pool);
    const [driverId] = fixture.userIds;
    const service = createDeliveryOrderService({ pool });
    const results = await Promise.allSettled(fixture.orderIds.slice(0, 2).map((orderId, index) => service.acceptOrder({
      orderId, driverId, actor: { id: driverId, username: 'same-driver' },
      deviceId: `test-device-1-${fixture.suffix}`,
      idempotencyKey: `same-driver-${index}-${fixture.suffix}`,
    })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'DRIVER_AT_CAPACITY');
  } finally {
    await cleanup(pool, fixture);
    await pool.end();
  }
});

test('Admin y Delivery concurrentes no corrompen la asignación', async () => {
  const pool = createPool({ max: 6 });
  let fixture;
  try {
    fixture = await createFixture(pool);
    const service = createDeliveryOrderService({ pool });
    const [adminDriver, acceptingDriver] = fixture.userIds;
    const [reservation, acceptance] = await Promise.allSettled([
      service.reserveOrder({
        orderId: fixture.orderIds[0], driverId: adminDriver,
        actor: { id: adminDriver, username: 'test-admin' },
        idempotencyKey: `admin-race-${fixture.suffix}`,
      }),
      service.acceptOrder({
        orderId: fixture.orderIds[0], driverId: acceptingDriver,
        actor: { id: acceptingDriver, username: 'test-delivery' },
        deviceId: `test-device-2-${fixture.suffix}`,
        idempotencyKey: `delivery-race-${fixture.suffix}`,
      }),
    ]);
    assert.equal([reservation, acceptance].filter((result) => result.status === 'fulfilled').length, 1);
    const persisted = await pool.query('SELECT delivery_user_id,delivery_status FROM pedidos_app_orders WHERE id=$1', [fixture.orderIds[0]]);
    assert.ok(fixture.userIds.includes(persisted.rows[0].delivery_user_id));
    assert.ok(['Pendiente', 'Aceptado'].includes(persisted.rows[0].delivery_status));
  } finally {
    await cleanup(pool, fixture);
    await pool.end();
  }
});

test('idempotencia, capacidad comprometida y GPS duplicado se resuelven en servidor', async () => {
  const pool = createPool({ max: 4 });
  let fixture;
  try {
    fixture = await createFixture(pool);
    const [driverId] = fixture.userIds;
    const deviceId = `test-device-1-${fixture.suffix}`;
    const orders = createDeliveryOrderService({ pool });
    const first = await orders.acceptOrder({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `same-${fixture.suffix}`,
    });
    const replay = await orders.acceptOrder({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `same-${fixture.suffix}`,
    });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    await assert.rejects(() => orders.acceptOrder({
      orderId: fixture.orderIds[2], driverId,
      actor: { id: driverId, username: 'driver-capacity' }, deviceId,
      idempotencyKey: `capacity-${fixture.suffix}`,
    }), (error) => error.code === 'DRIVER_AT_CAPACITY');

    const location = createDeliveryLocationService({ pool });
    const point = {
      id: `point-${fixture.suffix}`, latitude: 10.468235, longitude: -73.253628,
      accuracy: 10, capturedAt: new Date().toISOString(), provider: 'test',
    };
    const sync = await location.ingestBatch({ driverId, deviceId, points: [point, point] });
    assert.equal(sync.accepted, 1);
    assert.equal(sync.duplicated, 1);
    const started = await orders.startDelivery({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `start-${fixture.suffix}`,
    });
    const startedReplay = await orders.startDelivery({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `start-${fixture.suffix}`,
    });
    assert.equal(started.replayed, false);
    assert.equal(startedReplay.replayed, true);
    const deliveryPoint = {
      ...point, id: `delivery-point-${fixture.suffix}`,
      capturedAt: new Date(Date.now() + 10).toISOString(),
    };
    await location.ingestBatch({ driverId, deviceId, points: [deliveryPoint] });
    const completion = {
      confirmReceived: true, notes: 'Prueba transaccional', rating: 5,
      evidence: null, geofenceOverrideId: null,
    };
    const completed = await orders.completeDelivery({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `complete-${fixture.suffix}`, completion,
    });
    const completedReplay = await orders.completeDelivery({
      orderId: fixture.orderIds[1], driverId,
      actor: { id: driverId, username: 'driver-idempotent' }, deviceId,
      idempotencyKey: `complete-${fixture.suffix}`, completion,
    });
    assert.equal(completed.replayed, false);
    assert.equal(completedReplay.replayed, true);
    assert.equal(completed.order.delivery_status, 'Entregado');
  } finally {
    await cleanup(pool, fixture);
    await pool.end();
  }
});
