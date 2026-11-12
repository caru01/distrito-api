const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const { createPool } = require('../src/db');
const configureCustomerAuth = require('../customer_auth_api');

test('Customer Auth API - Flujo completo de registro, login, me, profile y logout', async () => {
  const pool = createPool({ max: 1 });
  const app = express();
  app.use(express.json());

  const JWT_SECRET = 'test-secret-key-12345';
  configureCustomerAuth(app, { pool, JWT_SECRET });

  const request = supertest(app);
  const testEmail = `test.client.${Date.now()}@distritohouse.app`;
  const testPassword = 'Password123!';

  try {
    // 1. Registro
    const regRes = await request
      .post('/api/pedidos/customer/register')
      .send({
        name: 'Cliente Prueba Móvil',
        phone: '3001234567',
        email: testEmail,
        password: testPassword,
        default_address: 'Cra 15 # 22-10',
        default_barrio: 'San Joaquín',
      });

    assert.equal(regRes.status, 201, `Error en registro: ${JSON.stringify(regRes.body)}`);
    assert.equal(regRes.body.status, 'ok');
    assert.ok(regRes.body.token);
    assert.equal(regRes.body.customer.email, testEmail);

    const token = regRes.body.token;

    // 2. Intento de registro duplicado (debe fallar con 409)
    const dupRes = await request
      .post('/api/pedidos/customer/register')
      .send({
        name: 'Otro Nombre',
        phone: '3009999999',
        email: testEmail,
        password: testPassword,
      });
    assert.equal(dupRes.status, 409);

    // 3. Login exitoso
    const loginRes = await request
      .post('/api/pedidos/customer/login')
      .send({
        email: testEmail,
        password: testPassword,
      });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.body.token);
    assert.equal(loginRes.body.customer.name, 'Cliente Prueba Móvil');

    // 4. Login con contraseña incorrecta (401)
    const badLogin = await request
      .post('/api/pedidos/customer/login')
      .send({
        email: testEmail,
        password: 'wrongpassword',
      });
    assert.equal(badLogin.status, 401);

    // 5. Consulta de perfil (/me)
    const meRes = await request
      .get('/api/pedidos/customer/me')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.customer.email, testEmail);

    // 6. Actualización de perfil
    const updateRes = await request
      .put('/api/pedidos/customer/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Cliente Actualizado',
        default_address: 'Calle 16 # 8-40',
        default_barrio: 'Los Cortijos',
      });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.customer.name, 'Cliente Actualizado');
    assert.equal(updateRes.body.customer.address, 'Calle 16 # 8-40');

    // 7. Recuperación de contraseña (forgot-password)
    const forgotRes = await request
      .post('/api/pedidos/customer/forgot-password')
      .send({ email: testEmail });
    assert.equal(forgotRes.status, 200);
    assert.ok(forgotRes.body.debugCode);

    // 8. Restablecimiento con código
    const resetRes = await request
      .post('/api/pedidos/customer/reset-password')
      .send({
        email: testEmail,
        code: forgotRes.body.debugCode,
        new_password: 'NewPassword123!',
      });
    assert.equal(resetRes.status, 200);

    // 9. Login con nueva contraseña
    const newLoginRes = await request
      .post('/api/pedidos/customer/login')
      .send({
        email: testEmail,
        password: 'NewPassword123!',
      });
    assert.equal(newLoginRes.status, 200);

    // 10. Logout
    const logoutRes = await request
      .post('/api/pedidos/customer/logout')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(logoutRes.status, 200);

    // Limpieza de datos de prueba
    await pool.query('DELETE FROM pedidos_app_customer_accounts WHERE email = $1', [testEmail]);
  } finally {
    await pool.end();
  }
});
