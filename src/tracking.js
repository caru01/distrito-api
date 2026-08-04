const jwt = require('jsonwebtoken');

const TRACKING_AUDIENCE = 'order-tracking';
const TRACKING_ISSUER = 'distrito-api';
const TRACKING_TOKEN_TTL = '48h';
const FINAL_STATUS_GRACE_MS = 15 * 60 * 1000;
const FINAL_STATUSES = new Set(['Entregado', 'Completado', 'Cancelado']);

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function trackingError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function issueTrackingToken(orderId, secret) {
  const normalizedId = Number(orderId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1 || !secret) {
    throw new Error('No fue posible crear el acceso temporal al seguimiento.');
  }
  return jwt.sign(
    { type: 'order_tracking', orderId: normalizedId },
    secret,
    { audience: TRACKING_AUDIENCE, issuer: TRACKING_ISSUER, expiresIn: TRACKING_TOKEN_TTL }
  );
}

function verifyTrackingToken(token, orderId, secret) {
  try {
    const payload = jwt.verify(String(token || ''), secret, {
      audience: TRACKING_AUDIENCE,
      issuer: TRACKING_ISSUER,
    });
    if (payload.type !== 'order_tracking' || Number(payload.orderId) !== Number(orderId)) {
      throw new Error('Pedido no autorizado');
    }
    return payload;
  } catch {
    throw trackingError('El enlace de seguimiento no es válido o ya caducó.', 410, 'TRACKING_LINK_EXPIRED');
  }
}

function isFinalOrder(order) {
  return FINAL_STATUSES.has(order.status) || FINAL_STATUSES.has(order.delivery_status);
}

function assertTemporaryLinkActive(order) {
  if (!isFinalOrder(order)) return;
  const finalAt = order.delivery_completed_at || order.delivered_at || order.completed_at || order.updated_at;
  const finalTimestamp = finalAt ? new Date(finalAt).getTime() : 0;
  if (!finalTimestamp || Date.now() - finalTimestamp > FINAL_STATUS_GRACE_MS) {
    throw trackingError('Este seguimiento finalizó porque el pedido ya fue entregado o cancelado.', 410, 'TRACKING_LINK_FINISHED');
  }
}

async function authorizeTrackingAccess(pool, { orderId, phone, token, secret }) {
  const normalizedId = Number(orderId);
  if (!Number.isInteger(normalizedId) || normalizedId < 1) {
    throw trackingError('Número de pedido inválido.', 400, 'TRACKING_ORDER_INVALID');
  }

  if (token) {
    verifyTrackingToken(token, normalizedId, secret);
    const { rows } = await pool.query(`
      SELECT id, status, delivery_status, delivery_completed_at, delivered_at,
             completed_at, updated_at
      FROM pedidos_app_orders
      WHERE id = $1
    `, [normalizedId]);
    if (!rows.length) throw trackingError('No encontramos el pedido.', 404, 'TRACKING_ORDER_NOT_FOUND');
    assertTemporaryLinkActive(rows[0]);
    return { order: rows[0], method: 'token' };
  }

  const phoneSuffix = normalizePhone(phone).slice(-10);
  if (phoneSuffix.length < 7) {
    throw trackingError('Número de pedido y teléfono válidos son obligatorios.', 400, 'TRACKING_PHONE_REQUIRED');
  }
  const { rows } = await pool.query(`
    SELECT id, status, delivery_status, delivery_completed_at, delivered_at,
           completed_at, updated_at
    FROM pedidos_app_orders
    WHERE id = $1 AND RIGHT(regexp_replace(customer_phone, '\\D', '', 'g'), 10) = $2
  `, [normalizedId, phoneSuffix]);
  if (!rows.length) throw trackingError('No encontramos un pedido con esos datos.', 404, 'TRACKING_ORDER_NOT_FOUND');
  return { order: rows[0], method: 'phone' };
}

module.exports = {
  FINAL_STATUS_GRACE_MS,
  authorizeTrackingAccess,
  issueTrackingToken,
  isFinalOrder,
  verifyTrackingToken,
};
