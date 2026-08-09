const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { createPool } = require('../src/db');

const apiRoot = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForApi(baseUrl, child, getLogs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`La API E2E terminó antes de iniciar.\n${getLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/pedidos/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.components?.outbox === 'ok') return;
      }
    } catch {
      // El proceso todavía está abriendo el puerto o conectando PostgreSQL.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`La API E2E no respondió a tiempo.\n${getLogs()}`);
}

async function request(baseUrl, route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.deviceId) headers.set('X-Device-Id', options.deviceId);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}/api/pedidos${route}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
  return { response, data };
}

async function login(baseUrl, username, password, deviceId) {
  const result = await request(baseUrl, '/admin/login', {
    body: { username, password, deviceId, deviceName: `E2E ${deviceId}` },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.token);
  assert.ok(result.data.refreshToken);
  return result.data;
}

async function readReplay(baseUrl, token, lastEventId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/api/pedidos/realtime/stream`, {
      headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': lastEventId },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('"replayed":true')) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    await reader.cancel();
    return received;
  } finally {
    clearTimeout(timeout);
  }
}

async function triggerAndReadSse(baseUrl, token, trigger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseUrl}/api/pedidos/realtime/stream`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const triggered = await trigger();
    let received = '';
    while (!received.includes('event: delivery_location')) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    await reader.cancel();
    return { received, triggered };
  } finally {
    clearTimeout(timeout);
  }
}

async function createFixture(pool) {
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const customerPhone = `3${String(Date.now()).slice(-9)}`;
  const password = `Delivery-${crypto.randomBytes(8).toString('hex')}!`;
  const passwordHash = await bcrypt.hash(password, 8);
  const userIds = [];
  const orderIds = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roles = await client.query(`
      SELECT id,name FROM pedidos_app_roles
      WHERE name IN ('Domiciliario','Repartidor','Super Administrador')
    `);
    const deliveryRole = roles.rows.find((role) => ['Domiciliario', 'Repartidor'].includes(role.name));
    const adminRole = roles.rows.find((role) => role.name === 'Super Administrador');
    assert.ok(deliveryRole, 'Debe existir un rol de reparto');
    assert.ok(adminRole, 'Debe existir Super Administrador');

    const definitions = [
      { prefix: 'driver', role: deliveryRole, name: 'Driver E2E' },
      { prefix: 'other', role: deliveryRole, name: 'Otro E2E' },
      { prefix: 'admin', role: adminRole, name: 'Admin E2E' },
    ];
    const users = {};
    for (const definition of definitions) {
      const inserted = await client.query(`
        INSERT INTO pedidos_app_users
          (username,password_hash,role,role_id,status,name,max_active_sessions)
        VALUES ($1,$2,$3,$4,'Activo',$5,3)
        RETURNING id,username
      `, [`${definition.prefix}-http-e2e-${suffix}`, passwordHash,
        definition.role.name, definition.role.id, definition.name]);
      users[definition.prefix] = inserted.rows[0];
      userIds.push(inserted.rows[0].id);
    }

    for (const deliveryUser of [users.driver, users.other]) {
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles (user_id,max_active_orders,availability_status)
        VALUES ($1,2,'Desconectado')
      `, [deliveryUser.id]);
    }

    for (const customer of ['Propio E2E', 'Externo E2E']) {
      const inserted = await client.query(`
        INSERT INTO pedidos_app_orders
          (customer_name,customer_phone,address,barrio,delivery_type,payment_method,total,
           status,delivery_status,delivery_provider_type,delivery_latitude,delivery_longitude,cart_json)
        VALUES ($1,$2,'Dirección E2E','Centro','domicilio','Efectivo',15000,
                'Listo','Pendiente','own',10.468235,-73.253628,$3::jsonb)
        RETURNING id
      `, [customer, customerPhone, JSON.stringify([{ title: 'Producto E2E', quantity: 1, price: 15000 }])]);
      orderIds.push(inserted.rows[0].id);
    }
    await client.query('COMMIT');
    return { suffix, password, users, userIds, orderIds, customerPhone, companyId: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool, fixture) {
  if (!fixture) return;
  await pool.query('DELETE FROM pedidos_app_audit_logs WHERE user_id=ANY($1::int[])', [fixture.userIds]);
  await pool.query('DELETE FROM pedidos_app_delivery_idempotency WHERE actor_user_id=ANY($1::int[]) OR order_id=ANY($2::int[])', [fixture.userIds, fixture.orderIds]);
  await pool.query(`
    DELETE FROM pedidos_app_domain_events
    WHERE aggregate_id=ANY($1::text[])
       OR payload->>'userId'=ANY($1::text[])
       OR payload->>'orderId'=ANY($2::text[])
  `, [fixture.userIds.map(String), fixture.orderIds.map(String)]);
  await pool.query('DELETE FROM pedidos_app_orders WHERE id=ANY($1::int[])', [fixture.orderIds]);
  const normalizedCustomerPhone = `+57${fixture.customerPhone}`;
  await pool.query('DELETE FROM pedidos_app_customers WHERE phone_e164=$1 AND name ILIKE $2', [normalizedCustomerPhone, '%E2E']);
  await pool.query(`
    DELETE FROM pedidos_app_crm_contacts contact
    WHERE contact.normalized_phone=$1
      AND NOT EXISTS (SELECT 1 FROM pedidos_app_orders order_data WHERE order_data.crm_contact_id=contact.id)
      AND NOT EXISTS (SELECT 1 FROM pedidos_app_crm_contact_customers link WHERE link.contact_id=contact.id)
  `, [normalizedCustomerPhone]);
  if (fixture.companyId) await pool.query('DELETE FROM pedidos_app_delivery_companies WHERE id=$1', [fixture.companyId]);
  await pool.query('DELETE FROM pedidos_app_users WHERE id=ANY($1::int[])', [fixture.userIds]);
}

test('E2E HTTP: sesiones, SSE, reparto propio y operador externo conservan integridad', { timeout: 60_000 }, async () => {
  const pool = createPool({ max: 8 });
  let fixture;
  let child;
  let child2;
  let logs = '';
  let logs2 = '';
  try {
    fixture = await createFixture(pool);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: apiRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog = (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); };
    child.stdout.on('data', appendLog);
    child.stderr.on('data', appendLog);
    await waitForApi(baseUrl, child, () => logs);

    const port2 = await freePort();
    const baseUrl2 = `http://127.0.0.1:${port2}`;
    child2 = spawn(process.execPath, ['server.js'], {
      cwd: apiRoot,
      env: { ...process.env, PORT: String(port2) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog2 = (chunk) => { logs2 = `${logs2}${chunk}`.slice(-20_000); };
    child2.stdout.on('data', appendLog2);
    child2.stderr.on('data', appendLog2);
    await waitForApi(baseUrl2, child2, () => logs2);

    const deviceA = `e2e-a-${fixture.suffix}`;
    const deviceB = `e2e-b-${fixture.suffix}`;
    await login(baseUrl, fixture.users.driver.username, fixture.password, deviceA);
    const deliveryAuth = await login(baseUrl, fixture.users.driver.username, fixture.password, deviceB);
    const otherAuth = await login(baseUrl, fixture.users.other.username, fixture.password, `other-${fixture.suffix}`);

    const sessions = await request(baseUrl, '/auth/me/sessions', { token: deliveryAuth.token });
    assert.equal(sessions.response.status, 200);
    const sessionA = sessions.data.data.find((session) => session.device_id === deviceA);
    assert.ok(sessionA);
    const foreignSessions = await request(baseUrl, '/auth/me/sessions', { token: otherAuth.token });
    const foreignSessionId = foreignSessions.data.data.find((session) => session.status === 'Activa').id;
    const foreignRevoke = await request(baseUrl, `/auth/me/sessions/${foreignSessionId}`, {
      method: 'DELETE', token: deliveryAuth.token,
    });
    assert.equal(foreignRevoke.response.status, 404);
    const ownRevoke = await request(baseUrl, `/auth/me/sessions/${sessionA.id}`, {
      method: 'DELETE', token: deliveryAuth.token,
    });
    assert.equal(ownRevoke.response.status, 200);

    await login(baseUrl, fixture.users.driver.username, fixture.password, `e2e-c-${fixture.suffix}`);
    await login(baseUrl, fixture.users.driver.username, fixture.password, `e2e-d-${fixture.suffix}`);
    const limit = await request(baseUrl, '/admin/login', {
      body: {
        username: fixture.users.driver.username, password: fixture.password,
        deviceId: `e2e-e-${fixture.suffix}`, deviceName: 'E2E límite',
      },
    });
    assert.equal(limit.response.status, 409);
    assert.equal(limit.data.code, 'SESSION_LIMIT_REACHED');

    const shift = await request(baseUrl, '/delivery/shift/start', {
      token: deliveryAuth.token, deviceId: deviceB, body: {}, idempotencyKey: `shift-${fixture.suffix}`,
    });
    assert.equal(shift.response.status, 200, JSON.stringify(shift.data));

    const bootstrap = await request(baseUrl, '/delivery/native/bootstrap', {
      token: deliveryAuth.token, deviceId: deviceB, body: {},
    });
    assert.equal(bootstrap.response.status, 200);
    const exchange = await request(baseUrl, '/delivery/native/exchange', {
      body: { bootstrapCode: bootstrap.data.bootstrapCode, deviceId: deviceB },
    });
    assert.equal(exchange.response.status, 200);
    assert.ok(exchange.data.trackingToken);
    const secondExchange = await request(baseUrl, '/delivery/native/exchange', {
      body: { bootstrapCode: bootstrap.data.bootstrapCode, deviceId: deviceB },
    });
    assert.equal(secondExchange.response.status, 401);

    const [ownOrderId, externalOrderId] = fixture.orderIds;
    const acceptKey = `accept-${fixture.suffix}`;
    const accepted = await request(baseUrl, `/delivery/orders/${ownOrderId}/accept`, {
      token: deliveryAuth.token, deviceId: deviceB, body: {}, idempotencyKey: acceptKey,
    });
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.order.deliveryStatus, 'Aceptado');
    const acceptedReplay = await request(baseUrl, `/delivery/orders/${ownOrderId}/accept`, {
      token: deliveryAuth.token, deviceId: deviceB, body: {}, idempotencyKey: acceptKey,
    });
    assert.equal(acceptedReplay.data.replayed, true);

    const beforePickup = await request(baseUrl, `/track/${ownOrderId}?phone=${fixture.customerPhone}`);
    assert.equal(beforePickup.data.order.delivery_status, 'Aceptado');
    assert.equal(beforePickup.data.order.has_live_gps, false);
    const acceptEvent = await pool.query(`
      SELECT event_id FROM pedidos_app_domain_events
      WHERE aggregate_type='order' AND aggregate_id=$1 AND event_type='order_accepted'
      ORDER BY id DESC LIMIT 1
    `, [String(ownOrderId)]);
    assert.ok(acceptEvent.rows[0]);

    const pickup = await request(baseUrl, `/delivery/orders/${ownOrderId}/pickup`, {
      token: deliveryAuth.token, deviceId: deviceB, body: {}, idempotencyKey: `pickup-${fixture.suffix}`,
    });
    assert.equal(pickup.response.status, 200);
    assert.equal(pickup.data.order.deliveryStatus, 'En camino');
    const replayText = await readReplay(baseUrl, deliveryAuth.token, acceptEvent.rows[0].event_id);
    assert.match(replayText, /event: order_updated/);
    assert.match(replayText, /"replayed":true/);

    const crossInstance = await triggerAndReadSse(baseUrl2, deliveryAuth.token, () => (
      request(baseUrl, '/delivery/location/batch', {
        token: deliveryAuth.token, deviceId: deviceB,
        body: { points: [{
          id: `http-gps-${fixture.suffix}`, latitude: 10.468235, longitude: -73.253628,
          accuracy: 8, capturedAt: new Date().toISOString(), provider: 'e2e',
        }] },
      })
    ));
    const gps = crossInstance.triggered;
    assert.equal(gps.response.status, 202, JSON.stringify(gps.data));
    assert.equal(gps.data.mode, 'DELIVERY');
    assert.match(crossInstance.received, new RegExp(`"orderId":${ownOrderId}`));
    const liveTracking = await request(baseUrl, `/track/${ownOrderId}?phone=${fixture.customerPhone}`);
    assert.equal(liveTracking.data.order.delivery_status, 'En camino');
    assert.equal(liveTracking.data.order.has_live_gps, true);

    const completeKey = `complete-${fixture.suffix}`;
    const completed = await request(baseUrl, `/delivery/orders/${ownOrderId}/complete`, {
      token: deliveryAuth.token, deviceId: deviceB, idempotencyKey: completeKey,
      body: { confirmReceived: true, notes: 'E2E entregado', rating: 5 },
    });
    assert.equal(completed.response.status, 200, JSON.stringify(completed.data));
    assert.equal(completed.data.order.deliveryStatus, 'Entregado');
    const completedReplay = await request(baseUrl, `/delivery/orders/${ownOrderId}/complete`, {
      token: deliveryAuth.token, deviceId: deviceB, idempotencyKey: completeKey,
      body: { confirmReceived: true, notes: 'E2E entregado', rating: 5 },
    });
    assert.equal(completedReplay.data.replayed, true);
    const finalTracking = await request(baseUrl, `/track/${ownOrderId}?phone=${fixture.customerPhone}`);
    assert.equal(finalTracking.data.order.has_live_gps, false);

    const adminAuth = await login(baseUrl, fixture.users.admin.username, fixture.password, `admin-${fixture.suffix}`);
    const company = await request(baseUrl, '/admin/delivery-companies', {
      token: adminAuth.token,
      body: { name: `Operador E2E ${fixture.suffix}`, phone: '3004445566', defaultFee: 8000 },
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.data));
    fixture.companyId = company.data.company.id;
    const assignedExternal = await request(baseUrl, `/admin/delivery/orders/${externalOrderId}/assign-external`, {
      token: adminAuth.token,
      body: { companyId: fixture.companyId, externalCost: 8000, etaMinutes: 20 },
    });
    assert.equal(assignedExternal.response.status, 200);
    assert.equal(assignedExternal.data.order.delivery_status, 'Asignado externo');
    assert.equal(assignedExternal.data.order.delivery_user_id, null);
    for (const step of ['external-handoff', 'external-start']) {
      const transitioned = await request(baseUrl, `/admin/delivery/orders/${externalOrderId}/${step}`, {
        token: adminAuth.token, body: {},
      });
      assert.equal(transitioned.response.status, 200, JSON.stringify(transitioned.data));
    }
    const externalComplete = await request(baseUrl, `/admin/delivery/orders/${externalOrderId}/external-complete`, {
      token: adminAuth.token, body: { confirmReceived: true, confirmedBy: 'Cliente E2E' },
    });
    assert.equal(externalComplete.response.status, 200);
    assert.equal(externalComplete.data.order.delivery_status, 'Entregado');
    const externalTracking = await request(baseUrl, `/track/${externalOrderId}?phone=${fixture.customerPhone}`);
    assert.equal(externalTracking.data.order.tracking_mode, 'status');
    assert.equal(externalTracking.data.order.has_live_gps, false);
  } finally {
    for (const running of [child, child2]) {
      if (!running || running.exitCode !== null) continue;
      running.kill();
      await Promise.race([
        new Promise((resolve) => running.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    await cleanup(pool, fixture);
    await pool.end();
  }
});
