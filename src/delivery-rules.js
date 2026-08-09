const DELIVERY_ROLES = new Set(['Domiciliario', 'Repartidor']);
const CARRYING_DELIVERY_STATUSES = ['Aceptado', 'Recogido', 'En camino'];
const COMMITTED_DELIVERY_STATUSES = ['Pendiente', 'Aceptado', 'Recogido', 'En camino'];
const FINAL_DELIVERY_STATUSES = ['Entregado', 'Cancelado'];
const DEFAULT_MAX_ACTIVE_ORDERS = 5;
const MAX_ACTIVE_ORDERS_LIMIT = 5;

function normalizeMaxActiveOrders(value, fallback = DEFAULT_MAX_ACTIVE_ORDERS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_ACTIVE_ORDERS_LIMIT);
}

module.exports = {
  CARRYING_DELIVERY_STATUSES,
  COMMITTED_DELIVERY_STATUSES,
  DEFAULT_MAX_ACTIVE_ORDERS,
  DELIVERY_ROLES,
  FINAL_DELIVERY_STATUSES,
  MAX_ACTIVE_ORDERS_LIMIT,
  normalizeMaxActiveOrders,
};
