const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { createPool } = require('../src/db');

const JWT_SECRET = process.env.JWT_SECRET || 'distrito_jwt_secret_key_prod_2026';

test('TC-SEC-ORDER-ISOLATION: Aislamiento estricto de historial de pedidos entre clientes', async () => {
  const pool = createPool({ max: 1 });

  // Crear 2 clientes de prueba en appmobile_customer_accounts
  const phoneA = `301900${Math.floor(1000 + Math.random() * 9000)}`;
  const phoneB = `302900${Math.floor(1000 + Math.random() * 9000)}`;
  const emailA = `test_user_a_${Date.now()}@distritobg.test`;
  const emailB = `test_user_b_${Date.now()}@distritobg.test`;
  const emailGoogleNoPhone = `google_user_nophone_${Date.now()}@gmail.com`;

  let userAId, userBId, userGoogleId, shortUserId;
  let orderAId, orderBId;

  try {
    // 1. Insertar usuario A con phoneA
    const resA = await pool.query(
      `INSERT INTO appmobile_customer_accounts (name, phone, email, password_hash, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, 'hash_test_a', TRUE, NOW(), NOW())
       RETURNING id`,
      ['Usuario A Test', `57${phoneA}`, emailA]
    );
    userAId = resA.rows[0].id;

    // 2. Insertar usuario B con phoneB
    const resB = await pool.query(
      `INSERT INTO appmobile_customer_accounts (name, phone, email, password_hash, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, 'hash_test_b', TRUE, NOW(), NOW())
       RETURNING id`,
      ['Usuario B Test', `57${phoneB}`, emailB]
    );
    userBId = resB.rows[0].id;

    // 3. Insertar usuario Google con teléfono vacío
    const resG = await pool.query(
      `INSERT INTO appmobile_customer_accounts (name, phone, email, password_hash, email_verified, created_at, updated_at)
       VALUES ($1, '', $2, 'hash_test_google', TRUE, NOW(), NOW())
       RETURNING id`,
      ['Usuario Google Sin Telefono', emailGoogleNoPhone]
    );
    userGoogleId = resG.rows[0].id;

    // 4. Crear un pedido para el Usuario A
    const orderARes = await pool.query(
      `INSERT INTO pedidos_app_orders (customer_name, customer_phone, delivery_type, payment_method, total, status, delivery_status, created_at)
       VALUES ($1, $2, 'Domicilio', 'Efectivo', 35000, 'Nuevo', 'Pendiente', NOW())
       RETURNING id`,
      ['Usuario A Test', `57${phoneA}`]
    );
    orderAId = orderARes.rows[0].id;

    // 5. Crear un pedido para el Usuario B
    const orderBRes = await pool.query(
      `INSERT INTO pedidos_app_orders (customer_name, customer_phone, delivery_type, payment_method, total, status, delivery_status, created_at)
       VALUES ($1, $2, 'Recoger en local', 'Transferencia', 28000, 'Nuevo', 'Pendiente', NOW())
       RETURNING id`,
      ['Usuario B Test', `57${phoneB}`]
    );
    orderBId = orderBRes.rows[0].id;

    // Generar tokens JWT para cada usuario
    const tokenA = jwt.sign({ id: userAId, role: 'customer', email: emailA, name: 'Usuario A', phone: `57${phoneA}` }, JWT_SECRET);
    const tokenB = jwt.sign({ id: userBId, role: 'customer', email: emailB, name: 'Usuario B', phone: `57${phoneB}` }, JWT_SECRET);
    const tokenGoogleNoPhone = jwt.sign({ id: userGoogleId, role: 'customer', email: emailGoogleNoPhone, name: 'Usuario Google' }, JWT_SECRET);

    // Subtest 1: Usuario A consulta sus pedidos
    const resOrdersA = await request(app)
      .get('/api/pedidos/customer/orders')
      .set('Authorization', `Bearer ${tokenA}`);

    assert.equal(resOrdersA.status, 200);
    assert.equal(resOrdersA.body.status, 'ok');
    assert.ok(Array.isArray(resOrdersA.body.orders));
    const idsA = resOrdersA.body.orders.map(o => o.id);
    assert.ok(idsA.includes(orderAId), 'Debe incluir el pedido del usuario A');
    assert.ok(!idsA.includes(orderBId), 'NUNCA debe incluir el pedido del usuario B');

    // Subtest 2: Usuario B consulta sus pedidos
    const resOrdersB = await request(app)
      .get('/api/pedidos/customer/orders')
      .set('Authorization', `Bearer ${tokenB}`);

    assert.equal(resOrdersB.status, 200);
    assert.equal(resOrdersB.body.status, 'ok');
    assert.ok(Array.isArray(resOrdersB.body.orders));
    const idsB = resOrdersB.body.orders.map(o => o.id);
    assert.ok(idsB.includes(orderBId), 'Debe incluir el pedido del usuario B');
    assert.ok(!idsB.includes(orderAId), 'NUNCA debe incluir el pedido del usuario A');

    // Subtest 3: Usuario sin teléfono (Google o correo) recibe lista vacía
    const resOrdersG = await request(app)
      .get('/api/pedidos/customer/orders')
      .set('Authorization', `Bearer ${tokenGoogleNoPhone}`);

    assert.equal(resOrdersG.status, 200);
    assert.equal(resOrdersG.body.status, 'ok');
    assert.deepEqual(resOrdersG.body.orders, [], 'Debe retornar un array vacío de pedidos');

    // Subtest 4: Query params maliciosos en la URL no vulneran la identidad
    const resMalicious = await request(app)
      .get(`/api/pedidos/customer/orders?phone=57${phoneA}&customer_phone=57${phoneA}`)
      .set('Authorization', `Bearer ${tokenB}`);

    assert.equal(resMalicious.status, 200);
    assert.equal(resMalicious.body.status, 'ok');
    const idsMalicious = resMalicious.body.orders.map(o => o.id);
    assert.ok(!idsMalicious.includes(orderAId), 'Los parámetros query no deben permitir BOLA/IDOR');
    assert.ok(idsMalicious.includes(orderBId), 'Debe seguir retornando solo los pedidos del usuario B');

    // Subtest 5: Usuario con teléfono menor a 7 dígitos responde lista vacía
    const resShort = await pool.query(
      `INSERT INTO appmobile_customer_accounts (name, phone, email, password_hash, email_verified, created_at, updated_at)
       VALUES ('Short Phone User', '1234', 'short_${Date.now()}@test.com', 'hash', TRUE, NOW(), NOW())
       RETURNING id`
    );
    shortUserId = resShort.rows[0].id;
    const tokenShortDb = jwt.sign({ id: shortUserId, role: 'customer', email: 'short@test.com' }, JWT_SECRET);

    const resOrdersShort = await request(app)
      .get('/api/pedidos/customer/orders')
      .set('Authorization', `Bearer ${tokenShortDb}`);

    assert.equal(resOrdersShort.status, 200);
    assert.equal(resOrdersShort.body.status, 'ok');
    assert.deepEqual(resOrdersShort.body.orders, [], 'Usuario con teléfono < 7 dígitos debe recibir lista vacía');

  } catch (err) {
    console.error('ERROR EN TEST:', err);
    throw err;
  } finally {
    // Limpieza de datos de prueba
    if (orderAId) await pool.query('DELETE FROM pedidos_app_orders WHERE id = $1', [orderAId]);
    if (orderBId) await pool.query('DELETE FROM pedidos_app_orders WHERE id = $1', [orderBId]);
    if (userAId) await pool.query('DELETE FROM appmobile_customer_accounts WHERE id = $1', [userAId]);
    if (userBId) await pool.query('DELETE FROM appmobile_customer_accounts WHERE id = $1', [userBId]);
    if (userGoogleId) await pool.query('DELETE FROM appmobile_customer_accounts WHERE id = $1', [userGoogleId]);
    if (shortUserId) await pool.query('DELETE FROM appmobile_customer_accounts WHERE id = $1', [shortUserId]);
    await pool.end();
  }
});
