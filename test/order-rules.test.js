const test = require('node:test');
const assert = require('node:assert/strict');
const { ORDER_STATUSES, canTransitionOrder } = require('../src/order-rules');

test('los estados operativos aceptan únicamente transiciones válidas', () => {
  assert.equal(canTransitionOrder('Nuevo', 'En preparación'), true);
  assert.equal(canTransitionOrder('En preparación', 'Listo'), true);
  assert.equal(canTransitionOrder('Listo', 'En camino'), true);
  assert.equal(canTransitionOrder('Listo', 'Asignado externo'), true);
  assert.equal(canTransitionOrder('Asignado externo', 'Entregado al operador externo'), true);
  assert.equal(canTransitionOrder('Entregado al operador externo', 'En camino'), true);
  assert.equal(canTransitionOrder('Asignado externo', 'En camino'), false);
  assert.equal(canTransitionOrder('En camino', 'Entregado'), true);
  assert.equal(canTransitionOrder('Pendiente Pago', 'En preparación'), true);
  assert.equal(canTransitionOrder('Entregado', 'Nuevo'), false);
  assert.equal(canTransitionOrder('Cancelado', 'En preparación'), false);
  assert.equal(canTransitionOrder('Nuevo', 'Entregado'), false);
  assert.equal(canTransitionOrder('Nuevo', 'Estado inventado'), false);
});

test('todos los estados declarados son idempotentes', () => {
  for (const status of ORDER_STATUSES) {
    assert.equal(canTransitionOrder(status, status), true, status);
  }
});
