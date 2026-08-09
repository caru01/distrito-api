const ORDER_STATUSES = new Set([
  'Nuevo',
  'En preparación',
  'Listo',
  'Asignado externo',
  'Entregado al operador externo',
  'En camino',
  'Entregado',
  'Pendiente Pago',
  'Cancelado',
  'Completado',
]);

const ORDER_TRANSITIONS = Object.freeze({
  Nuevo: new Set(['En preparación', 'Pendiente Pago', 'Cancelado']),
  'Pendiente Pago': new Set(['Nuevo', 'En preparación', 'Cancelado']),
  'En preparación': new Set(['Listo', 'Pendiente Pago', 'Cancelado']),
  Listo: new Set(['Asignado externo', 'En camino', 'Entregado', 'Pendiente Pago', 'Cancelado']),
  'Asignado externo': new Set(['Entregado al operador externo', 'Cancelado']),
  'Entregado al operador externo': new Set(['En camino', 'Entregado', 'Cancelado']),
  'En camino': new Set(['Entregado', 'Cancelado']),
  Entregado: new Set(),
  Completado: new Set(),
  Cancelado: new Set(),
});

function canTransitionOrder(fromStatus, toStatus) {
  if (!ORDER_STATUSES.has(fromStatus) || !ORDER_STATUSES.has(toStatus)) return false;
  if (fromStatus === toStatus) return true;
  return Boolean(ORDER_TRANSITIONS[fromStatus]?.has(toStatus));
}

module.exports = { ORDER_STATUSES, ORDER_TRANSITIONS, canTransitionOrder };
