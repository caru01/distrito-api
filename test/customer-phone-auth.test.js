const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');
const { createPool } = require('../src/db');

test('TC-02: Registro de cliente exclusivamente con número de teléfono sin correo electrónico', async () => {
  const pool = createPool({ max: 1 });
  const testPhone = `300999${Math.floor(1000 + Math.random() * 9000)}`;

  try {
    // 1. Registro exitoso sin email
    const regRes = await request(app)
      .post('/api/pedidos/customer/register')
      .send({
        name: 'Cliente Prueba Celular',
        phone: testPhone,
        password: 'PasswordSegura123',
        default_address: 'Calle 15 # 10-20',
        default_barrio: 'Los Cortijos',
      });

    assert.equal(regRes.status, 201);
    assert.equal(regRes.body.status, 'ok');
    assert.ok(regRes.body.token);
    assert.equal(regRes.body.customer.name, 'Cliente Prueba Celular');
    assert.equal(regRes.body.customer.email, null); // Email es nulo de forma compatible

    // 2. Intento de registro duplicado con el mismo teléfono debe devolver HTTP 409
    const dupRes = await request(app)
      .post('/api/pedidos/customer/register')
      .send({
        name: 'Cliente Duplicado',
        phone: testPhone,
        password: 'OtraPassword456',
      });

    assert.equal(dupRes.status, 409);
    assert.ok(dupRes.body.error.includes('número de teléfono ya tiene una cuenta registrada'));

    // 3. Login exitoso utilizando el número de celular
    const loginRes = await request(app)
      .post('/api/pedidos/customer/login')
      .send({
        identifier: testPhone,
        password: 'PasswordSegura123',
      });

    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.body.status, 'ok');
    assert.ok(loginRes.body.token);
    assert.equal(loginRes.body.customer.name, 'Cliente Prueba Celular');

    // 4. Intento de login con teléfono inexistente devuelve HTTP 404 con not_registered: true
    const unregRes = await request(app)
      .post('/api/pedidos/customer/login')
      .send({
        identifier: '3999999999',
        password: 'PasswordSegura123',
      });

    assert.equal(unregRes.status, 404);
    assert.equal(unregRes.body.not_registered, true);
    assert.ok(unregRes.body.error.includes('no se encuentra registrada'));
  } finally {
    // Limpieza del usuario de prueba creado
    await pool.query('DELETE FROM appmobile_customer_accounts WHERE phone LIKE $1', [`%${testPhone}%`]);
    await pool.query('DELETE FROM pedidos_app_customers WHERE phone LIKE $1', [`%${testPhone}%`]);
    await pool.end();
  }
});
