const OWN_DELIVERY_TRANSITIONS = Object.freeze({
  Pendiente: new Set(['Aceptado', 'Cancelado']),
  Aceptado: new Set(['En camino', 'Cancelado']),
  Recogido: new Set(['En camino', 'Cancelado']),
  'En camino': new Set(['Entregado', 'Cancelado']),
  Entregado: new Set(),
  Cancelado: new Set(),
});

const COMMITTED_DELIVERY_STATUSES = Object.freeze(['Pendiente', 'Aceptado', 'Recogido', 'En camino']);
const ACTIVE_DELIVERY_STATUSES = Object.freeze(['Aceptado', 'Recogido', 'En camino']);
const ON_THE_WAY_DELIVERY_STATUSES = Object.freeze(['Recogido', 'En camino']);

function domainError(code, message, statusCode = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeLegacyDeliveryStatus(value) {
  return value === 'Recogido' ? 'En camino' : value;
}

function canTransitionOwnDelivery(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  return Boolean(OWN_DELIVERY_TRANSITIONS[fromStatus]?.has(toStatus));
}

function assertOwnDeliveryTransition(fromStatus, toStatus) {
  if (!canTransitionOwnDelivery(fromStatus, toStatus)) {
    throw domainError(
      'INVALID_ORDER_STATE',
      `No se puede cambiar la entrega de ${fromStatus || 'sin estado'} a ${toStatus}.`,
    );
  }
}

function commercialStatusForDelivery(deliveryStatus, currentCommercialStatus = null) {
  switch (deliveryStatus) {
    case 'Aceptado': return 'Listo';
    case 'Recogido':
    case 'En camino': return 'En camino';
    case 'Entregado': return 'Entregado';
    case 'Cancelado': return 'Cancelado';
    default: return currentCommercialStatus;
  }
}

function assertConsistentOwnState(commercialStatus, deliveryStatus) {
  const expected = commercialStatusForDelivery(deliveryStatus, commercialStatus);
  if (expected !== commercialStatus) {
    throw domainError(
      'INCONSISTENT_ORDER_STATE',
      `La combinación comercial=${commercialStatus} y entrega=${deliveryStatus} no es válida.`,
      500,
    );
  }
}

module.exports = {
  ACTIVE_DELIVERY_STATUSES,
  COMMITTED_DELIVERY_STATUSES,
  ON_THE_WAY_DELIVERY_STATUSES,
  OWN_DELIVERY_TRANSITIONS,
  assertConsistentOwnState,
  assertOwnDeliveryTransition,
  canTransitionOwnDelivery,
  commercialStatusForDelivery,
  domainError,
  normalizeLegacyDeliveryStatus,
};
