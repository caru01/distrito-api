const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || 'distrito_bg_secret_key_2026';

// Helper para crear tokens de prueba firmados
function makeTestToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      role_id: user.role_id,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test('TC-SEC-01: Usuario sin permiso administrativo específico recibe HTTP 403 al acceder a configuración financiera', async () => {
  // Usuario 4: Luzdanis (Cajero, Role ID 10) - NO tiene permiso 'Configuracion:editar'
  const cashierToken = makeTestToken({ id: 4, username: 'Luzdanis.lara', role_id: 10, role: 'Cajero' });

  const res = await request(app)
    .put('/api/pedidos/admin/settings')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ restaurant_name: 'Hackeado' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'No tienes permiso para realizar esta acción');
});

test('TC-SEC-02: Empleado sin permiso no puede modificar precios de productos (HTTP 403)', async () => {
  // Usuario 4: Luzdanis (Cajero, Role ID 10) - NO tiene permiso 'Productos:editar'
  const cashierToken = makeTestToken({ id: 4, username: 'Luzdanis.lara', role_id: 10, role: 'Cajero' });

  const res = await request(app)
    .put('/api/pedidos/admin/products/0f9e2a41-c6e7-4ad7-80be-c03ed60fdefa')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ price: 100 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'No tienes permiso para realizar esta acción');
});

test('TC-SEC-03: Prevención BOLA/IDOR: Petición de rastreo sin código ni token de verificación recibe HTTP 400/403', async () => {
  const res = await request(app)
    .get('/api/pedidos/track/1')
    .send();

  // Debe rechazar el intento de acceder a un pedido ajeno simplemente cambiando el ID
  assert.ok(res.status === 400 || res.status === 403 || res.status === 404);
});

test('TC-SEC-04: Usuario con rol Domiciliario tiene prohibido el acceso al panel administrativo (HTTP 403)', async () => {
  // Usuario 101: Luis Carlos (Domiciliario, Role ID 17)
  const deliveryToken = makeTestToken({ id: 101, username: 'luis.carlos', role_id: 17, role: 'Domiciliario' });

  const res = await request(app)
    .get('/api/pedidos/admin/orders')
    .set('Authorization', `Bearer ${deliveryToken}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Esta cuenta no tiene acceso al panel administrativo');
});

test('TC-SEC-05: Administrador autorizado (Super Administrador) mantiene acceso pleno a sus funciones (HTTP 200)', async () => {
  // Usuario 1: Camilo Rincones (Super Administrador, Role ID 2)
  const adminToken = makeTestToken({ id: 1, username: '1065841241', role_id: 2, role: 'Super Administrador' });

  const res = await request(app)
    .get('/api/pedidos/admin/settings')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.settings);
});
