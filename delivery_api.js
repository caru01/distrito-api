const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  CARRYING_DELIVERY_STATUSES,
  DELIVERY_ROLES,
  FINAL_DELIVERY_STATUSES,
} = require('./src/delivery-rules');
const { buildArrivalStatus } = require('./src/delivery-geo');
const { createDeliveryLocationService } = require('./src/delivery-location-service');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseCart(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatOrder(row, options = {}) {
  if (!row) return null;
  const hasExactDestination = row.delivery_latitude != null && row.delivery_longitude != null;
  const destination = hasExactDestination
    ? `${row.delivery_latitude},${row.delivery_longitude}`
    : [row.address, row.barrio, 'Valledupar, Colombia'].filter(Boolean).join(', ');
  const phone = normalizePhone(row.customer_phone);
  const cart = parseCart(row.cart_json).map((item) => ({
    id: item.id || item.product_id || null,
    title: item.title || item.name || 'Producto',
    quantity: Number(item.quantity || item.qty || 1),
    price: Number(item.price || 0),
    notes: item.notes || item.observations || item.observaciones || '',
  }));
  const arrival = buildArrivalStatus({
    destinationLatitude: row.delivery_latitude,
    destinationLongitude: row.delivery_longitude,
    latitude: row.driver_latitude,
    longitude: row.driver_longitude,
    accuracy: row.driver_accuracy,
    locationAt: row.driver_location_at,
    startedAt: row.picked_up_at || row.on_the_way_at || row.delivery_accepted_at,
    radiusMeters: row.delivery_completion_radius_meters,
    maxGpsAgeSeconds: row.gps_max_age_seconds,
    maxGpsAccuracyMeters: row.gps_max_accuracy_meters,
  });
  return {
    id: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    phoneLink: phone ? `tel:+${phone}` : null,
    whatsappLink: phone ? `https://wa.me/${phone}` : null,
    address: row.address,
    barrio: row.barrio,
    reference: row.delivery_reference || '',
    apartment: row.delivery_apartment || '',
    tower: row.delivery_tower || '',
    floor: row.delivery_floor || '',
    destinationLatitude: row.delivery_latitude == null ? null : Number(row.delivery_latitude),
    destinationLongitude: row.delivery_longitude == null ? null : Number(row.delivery_longitude),
    googlePlaceId: row.delivery_place_id || null,
    locationAdjusted: Boolean(row.delivery_location_adjusted),
    notes: row.notes || '',
    deliveryType: row.delivery_type,
    paymentMethod: row.payment_method,
    total: Number(row.total || 0),
    deliveryFee: Number(row.delivery_fee || row.configured_delivery_fee || 0),
    changeRequired: row.change_required == null ? null : Number(row.change_required),
    orderStatus: row.status,
    deliveryStatus: row.delivery_status,
    deliveryUserId: row.delivery_user_id,
    deliveryProviderType: row.delivery_provider_type || (row.delivery_user_id ? 'own' : null),
    externalCompany: row.external_delivery_company_id ? {
      id: Number(row.external_delivery_company_id),
      name: row.external_company_name || null,
      phone: row.external_company_phone || null,
      integrationType: row.external_company_integration_type || 'manual',
    } : null,
    externalDriverName: row.external_driver_name || null,
    externalDriverPhone: row.external_driver_phone || null,
    externalVehicleId: row.external_vehicle_id || null,
    externalDeliveryCost: Number(row.external_delivery_cost || 0),
    logisticsMargin: Number(row.delivery_fee || row.configured_delivery_fee || 0) - Number(row.external_delivery_cost || 0),
    externalDeliveryNotes: row.external_delivery_notes || '',
    externalEtaMinutes: row.external_eta_minutes == null ? null : Number(row.external_eta_minutes),
    externalAssignedAt: row.external_assigned_at || null,
    externalHandedOffAt: row.external_handed_off_at || null,
    externalConfirmedAt: row.external_delivery_confirmed_at || null,
    externalConfirmedBy: row.external_delivery_confirmed_by_name || null,
    items: cart,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.delivery_accepted_at,
    pickedUpAt: row.picked_up_at,
    onTheWayAt: row.on_the_way_at,
    completedAt: row.delivery_completed_at,
    distanceKm: row.delivery_distance_km == null ? null : Number(row.delivery_distance_km),
    durationSeconds: row.delivery_duration_seconds == null ? null : Number(row.delivery_duration_seconds),
    deliveryNotes: row.delivery_notes || '',
    deliveryRating: row.delivery_rating == null ? null : Number(row.delivery_rating),
    version: Number(row.version || 1),
    geofenceOverrideId: row.geofence_override_id == null ? null : Number(row.geofence_override_id),
    googleMapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`,
    driverName: row.driver_name || null,
    driverPhone: row.driver_phone || null,
    vehicleType: row.vehicle_type || null,
    plate: row.plate || null,
    driverLatitude: arrival.hasCurrentLocation ? Number(row.driver_latitude) : null,
    driverLongitude: arrival.hasCurrentLocation ? Number(row.driver_longitude) : null,
    driverLocationAt: row.driver_location_at || null,
    arrival,
    store: {
      name: row.store_name || 'Distrito BG',
      address: row.store_address || 'Valledupar, Colombia',
      latitude: row.store_latitude == null ? null : Number(row.store_latitude),
      longitude: row.store_longitude == null ? null : Number(row.store_longitude),
    },
    ...(options.driverTrail ? { driverTrail: options.driverTrail } : {}),
    ...(options.includeEvidence ? { deliveryEvidence: row.delivery_evidence || null } : {}),
  };
}

function formatAvailableOrder(row) {
  const order = formatOrder(row);
  return {
    id: order.id,
    customerName: order.customerName,
    address: order.address,
    barrio: order.barrio,
    deliveryType: order.deliveryType,
    paymentMethod: order.paymentMethod,
    total: order.total,
    deliveryFee: order.deliveryFee,
    orderStatus: order.orderStatus,
    deliveryStatus: order.deliveryStatus,
    deliveryUserId: order.deliveryUserId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    destinationLatitude: order.destinationLatitude,
    destinationLongitude: order.destinationLongitude,
    store: order.store,
    googleMapsUrl: order.googleMapsUrl,
    restricted: true,
  };
}

function createRealtimeHub() {
  const clients = new Set();

  const remove = (client) => {
    clearInterval(client.heartbeat);
    clients.delete(client);
  };

  const add = (req, res, metadata) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    for (const replay of metadata.replayEvents || []) {
      const payload = { ...(replay.payload || {}), eventId: replay.event_id, occurredAt: replay.occurred_at, replayed: true };
      const eventName = replay.aggregate_type === 'order'
        ? 'order_updated'
        : replay.aggregate_type === 'driver' ? 'driver_presence' : replay.event_type;
      res.write(`id: ${replay.event_id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    const client = { res, ...metadata };
    client.nextValidationAt = Date.now() + 60000;
    client.heartbeat = setInterval(async () => {
      try {
        if (client.validate && Date.now() >= client.nextValidationAt) {
          client.nextValidationAt = Date.now() + 60000;
          if (!await client.validate()) {
            const event = client.kind === 'tracking' ? 'tracking_expired' : 'session_expired';
            const error = client.kind === 'tracking'
              ? 'El enlace temporal de seguimiento finalizó'
              : 'La sesión caducó por inactividad';
            res.write(`event: ${event}\ndata: ${JSON.stringify({ error })}\n\n`);
            res.end(); remove(client); return;
          }
        }
        res.write(': heartbeat\n\n');
      } catch {
        res.end(); remove(client);
      }
    }, 25000);
    clients.add(client);
    req.on('close', () => remove(client));
  };

  const publish = (event, payload = {}, predicate = () => true) => {
    const eventId = payload.eventId || payload.event_id || null;
    const packet = `${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ ...payload, emittedAt: new Date().toISOString() })}\n\n`;
    for (const client of clients) {
      if (!predicate(client)) continue;
      try {
        client.res.write(packet);
      } catch {
        remove(client);
      }
    }
  };

  const onlineUserIds = () => new Set(
    [...clients]
      .filter((client) => client.kind === 'authenticated' && DELIVERY_ROLES.has(client.role))
      .map((client) => Number(client.userId)),
  );

  const stats = () => ({
    clients: clients.size,
    authenticated: [...clients].filter((client) => client.kind === 'authenticated').length,
    tracking: [...clients].filter((client) => client.kind === 'tracking').length,
  });
  return { add, publish, onlineUserIds, stats };
}

module.exports = function registerDeliveryApi(app, dependencies) {
  const {
    pool, authenticateToken, requirePermission, trackingLimiter, webpush,
    publicVapidKey, minPasswordLength, authorizeTrackingAccess, trackingSecret,
    deliveryOrderService, publishEphemeral,
  } = dependencies;
  const realtime = createRealtimeHub();
  const deliveryLocationService = createDeliveryLocationService({ pool });

  const requireDeliveryUser = async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT u.id, COALESCE(r.name, u.role) AS role,
               COALESCE(profile.max_active_orders, 5)::int AS max_active_orders
        FROM pedidos_app_users u
        LEFT JOIN pedidos_app_roles r ON r.id = u.role_id
        LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        WHERE u.id = $1 AND u.status = 'Activo'
      `, [req.user.id]);
      if (!rows.length || !DELIVERY_ROLES.has(rows[0].role)) {
        return res.status(403).json({ error: 'Esta cuenta no tiene acceso a Distrito Delivery' });
      }
      req.deliveryUser = rows[0];
      next();
    } catch (error) {
      console.error('Error validando domiciliario:', error);
      res.status(500).json({ error: 'No fue posible validar el perfil de entrega' });
    }
  };

  const sendPush = async ({ userId = null, audience = 'delivery', title, body, url = '/' }) => {
    const params = [audience];
    let userFilter = '';
    if (userId) {
      params.push(userId);
      userFilter = 'AND user_id = $2';
    }
    const { rows } = await pool.query(`
      SELECT endpoint, subscription_json
      FROM pedidos_app_push_subscriptions
      WHERE audience = $1 ${userFilter}
    `, params);
    await Promise.all(rows.map(async (row) => {
      const subscription = typeof row.subscription_json === 'string'
        ? JSON.parse(row.subscription_json)
        : row.subscription_json;
      try {
        await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await pool.query('DELETE FROM pedidos_app_push_subscriptions WHERE endpoint = $1', [row.endpoint]);
        } else {
          console.error('No fue posible enviar una notificación delivery:', error.message);
        }
      }
    }));
  };

  const requestDeviceId = (req) => String(
    req.headers['x-device-id'] || req.body?.deviceId || req.query?.deviceId || '',
  ).trim().slice(0, 100);

  const sendDomainError = (res, error, fallback = 'No fue posible completar la operación') => {
    console.error(JSON.stringify({
      level: error.statusCode && error.statusCode < 500 ? 'warn' : 'error',
      component: 'delivery-api', code: error.code || 'UNEXPECTED_ERROR', message: error.message,
    }));
    return res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || 'DELIVERY_OPERATION_FAILED',
      error: error.statusCode ? error.message : fallback,
      details: error.details,
    });
  };

  const publishLocationEvent = async (payload) => {
    if (publishEphemeral) return publishEphemeral('delivery_location', payload);
    realtime.publish('delivery_location', payload, (connectedClient) => {
      const orderIds = Array.isArray(payload.orderIds) ? payload.orderIds.map(Number) : [Number(payload.orderId)];
      if (connectedClient.kind === 'tracking') return orderIds.includes(Number(connectedClient.orderId));
      if (DELIVERY_ROLES.has(connectedClient.role)) return Number(connectedClient.userId) === Number(payload.deliveryUserId);
      return true;
    });
    return undefined;
  };

  const publishLocationResult = async (driverId, result) => {
    if (!result.position) return;
    await publishLocationEvent({
      eventId: `gps-${driverId}-${result.position.capturedAt}`,
      orderId: result.orderIds?.[0] || null,
      orderIds: result.orderIds || [],
      deliveryUserId: driverId,
      latitude: result.position.latitude,
      longitude: result.position.longitude,
      accuracy: result.position.accuracy,
      capturedAt: result.position.capturedAt,
    });
  };

  const orderSelect = `
    SELECT order_data.*,
           settings.delivery_cost AS configured_delivery_fee,
           settings.delivery_completion_radius_meters,
           settings.gps_max_age_seconds,
           settings.gps_max_accuracy_meters,
           settings.restaurant_name AS store_name,
           COALESCE(settings.kitchen_address, settings.address) AS store_address,
           settings.store_latitude,
           settings.store_longitude,
           TRIM(CONCAT(driver.name, ' ', driver.last_name)) AS driver_name,
           driver.phone AS driver_phone,
           profile.vehicle_type,
           profile.plate,
           profile.current_latitude AS driver_latitude,
           profile.current_longitude AS driver_longitude,
           profile.current_accuracy AS driver_accuracy,
           profile.last_location_at AS driver_location_at
           ,(SELECT override_data.id FROM pedidos_app_delivery_geofence_overrides override_data
             WHERE override_data.order_id=order_data.id ORDER BY override_data.created_at DESC LIMIT 1) AS geofence_override_id
           ,company.name AS external_company_name
           ,company.phone AS external_company_phone
           ,company.integration_type AS external_company_integration_type
    FROM pedidos_app_orders order_data
    LEFT JOIN pedidos_app_settings settings ON settings.id = 1
    LEFT JOIN pedidos_app_users driver ON driver.id = order_data.delivery_user_id
    LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = order_data.delivery_user_id
    LEFT JOIN pedidos_app_delivery_companies company ON company.id = order_data.external_delivery_company_id
  `;

  app.get('/api/pedidos/push/public-key', (req, res) => {
    res.json({ status: 'ok', publicKey: publicVapidKey });
  });

  app.get('/api/pedidos/realtime/stream', authenticateToken, async (req, res) => {
    const lastEventId = String(req.headers['last-event-id'] || '').trim();
    let replayEvents = [];
    if (/^[0-9a-f-]{36}$/i.test(lastEventId)) {
      const replay = await pool.query(`
        WITH anchor AS (
          SELECT occurred_at FROM pedidos_app_domain_events WHERE event_id=$1::uuid
        )
        SELECT event.event_id,event.aggregate_type,event.aggregate_id,event.event_type,
               event.payload,event.occurred_at
        FROM pedidos_app_domain_events event, anchor
        WHERE (event.occurred_at,event.id) > (anchor.occurred_at,
          (SELECT id FROM pedidos_app_domain_events WHERE event_id=$1::uuid))
          AND (event.event_type <> 'session_revoked'
               OR (event.payload->>'userId')::integer=$2)
        ORDER BY event.occurred_at,event.id
        LIMIT 200
      `, [lastEventId, req.user.id]);
      replayEvents = replay.rows;
    }
    realtime.add(req, res, {
      kind: 'authenticated', userId: req.user.id, role: req.user.role,
      replayEvents,
      validate: async () => {
        if (!req.user.jti) return false;
        const { rowCount } = await pool.query(`
          SELECT 1
          FROM pedidos_app_sessions session
          JOIN pedidos_app_users app_user ON app_user.id = session.user_id
          WHERE session.token_jti = $1 AND session.user_id = $2 AND session.status = 'Activa'
            AND session.expires_at > NOW()
            AND session.last_active >= NOW() - make_interval(mins => COALESCE(app_user.session_idle_minutes, 60))
        `, [req.user.jti, req.user.id]);
        return rowCount > 0;
      },
    });
  });

  app.get('/api/pedidos/track/:id/stream', trackingLimiter, async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const access = {
        orderId,
        phone: req.query.phone,
        code: req.query.c,
        token: req.query.token,
        secret: trackingSecret,
      };
      await authorizeTrackingAccess(pool, access);
      realtime.add(req, res, {
        kind: 'tracking',
        orderId,
        validate: async () => {
          try {
            await authorizeTrackingAccess(pool, access);
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      console.error('Error abriendo seguimiento en vivo:', error);
      res.status(error.statusCode || 500).end();
    }
  });

  app.get('/api/pedidos/delivery/me', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      await pool.query(`
        INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status)
        VALUES ($1, 'Desconectado')
        ON CONFLICT (user_id) DO UPDATE
        SET connected_at = CASE WHEN pedidos_app_delivery_profiles.shift_active THEN NOW() ELSE connected_at END,
            last_seen_at = CASE WHEN pedidos_app_delivery_profiles.shift_active THEN NOW() ELSE last_seen_at END,
            updated_at = NOW()
      `, [req.user.id]);
      const { rows } = await pool.query(`
        SELECT u.id, u.username, u.name, u.last_name, u.document, u.email, u.phone, u.photo_url,
               profile.vehicle_name, profile.vehicle_type, profile.plate, profile.documents,
               profile.availability_status, profile.max_active_orders,
               profile.shift_active, profile.shift_started_at, profile.shift_ended_at,
               profile.last_seen_at, profile.last_location_at, profile.tracking_device_id,
               profile.tracking_mode, profile.gps_status,
               (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = u.id
                  AND COALESCE(active_order.delivery_provider_type,'own')='own'
                  AND active_order.delivery_status IN ('Pendiente','Aceptado','Recogido','En camino')) AS committed_orders,
               (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = u.id
                  AND active_order.delivery_status = 'Pendiente') AS reserved_orders,
               (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = u.id
                  AND active_order.delivery_status = 'Aceptado') AS accepted_orders,
               (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = u.id
                  AND active_order.delivery_status IN ('Recogido','En camino')) AS on_the_way_orders,
               CASE WHEN profile.rating_count > 0 THEN ROUND(profile.rating_sum / profile.rating_count, 2) ELSE 0 END AS rating
        FROM pedidos_app_users u
        JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        WHERE u.id = $1
      `, [req.user.id]);
      const settingsResult = await pool.query(`
        SELECT gps_delivery_interval_seconds, gps_free_interval_seconds,
               presence_heartbeat_interval_seconds, presence_timeout_seconds,
               gps_max_age_seconds, gps_max_accuracy_meters, offline_location_queue_limit,
               default_max_driver_capacity, sse_reconnect_initial_ms, sse_reconnect_max_ms
        FROM pedidos_app_settings WHERE id=1
      `);
      const profile = rows[0];
      res.json({
        status: 'ok',
        profile: { ...profile, active_orders: Number(profile.accepted_orders || 0) + Number(profile.on_the_way_orders || 0) },
        operation: settingsResult.rows[0] || {},
      });
    } catch (error) {
      console.error('Error cargando perfil delivery:', error);
      res.status(500).json({ error: 'No fue posible cargar el perfil' });
    }
  });

  app.put('/api/pedidos/delivery/profile', authenticateToken, requireDeliveryUser, async (req, res) => {
    const client = await pool.connect();
    try {
      const { phone, email, photoUrl, vehicleName, vehicleType, plate, documents, currentPassword, newPassword } = req.body;
      await client.query('BEGIN');
      if (newPassword) {
        if (!currentPassword || String(newPassword).length < minPasswordLength) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Confirma la contraseña actual y usa al menos ${minPasswordLength} caracteres` });
        }
        const { rows } = await client.query('SELECT password_hash FROM pedidos_app_users WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (!rows.length || !await bcrypt.compare(currentPassword, rows[0].password_hash)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }
        const passwordHash = await bcrypt.hash(String(newPassword), 10);
        await client.query('UPDATE pedidos_app_users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [passwordHash, req.user.id]);
      }
      await client.query(`
        UPDATE pedidos_app_users
        SET phone = COALESCE($1, phone), email = COALESCE($2, email), photo_url = COALESCE($3, photo_url)
        WHERE id = $4
      `, [phone || null, email || null, photoUrl || null, req.user.id]);
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles (user_id, vehicle_name, vehicle_type, plate, documents)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (user_id) DO UPDATE SET
          vehicle_name = EXCLUDED.vehicle_name,
          vehicle_type = EXCLUDED.vehicle_type,
          plate = EXCLUDED.plate,
          documents = EXCLUDED.documents,
          updated_at = NOW()
      `, [req.user.id, vehicleName || null, vehicleType || null, String(plate || '').toUpperCase() || null, JSON.stringify(documents || {})]);
      await client.query('COMMIT');
      res.json({ status: 'ok' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error actualizando perfil delivery:', error);
      res.status(500).json({ error: 'No fue posible guardar el perfil' });
    } finally {
      client.release();
    }
  });

  app.post('/api/pedidos/delivery/shift/start', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const result = await deliveryOrderService.startShift({
        driverId: req.user.id,
        actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
        transfer: false,
      });
      res.json(result);
    } catch (error) {
      sendDomainError(res, error, 'No fue posible iniciar el turno');
    }
  });

  app.post('/api/pedidos/delivery/shift/heartbeat', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const presence = await deliveryOrderService.heartbeat({
        driverId: req.user.id,
        deviceId: requestDeviceId(req),
        gpsStatus: req.body.gpsStatus,
      });
      res.json({ status: 'ok', presence });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible actualizar la presencia');
    }
  });

  app.post('/api/pedidos/delivery/shift/end', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const result = await deliveryOrderService.endShift({
        driverId: req.user.id,
        actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
      });
      res.json(result);
    } catch (error) {
      sendDomainError(res, error, 'No fue posible finalizar el turno');
    }
  });

  app.post('/api/pedidos/delivery/shift/transfer-device', authenticateToken, requireDeliveryUser, async (req, res) => {
    if (req.body.confirm !== true) return res.status(400).json({ code: 'TRANSFER_CONFIRMATION_REQUIRED', error: 'Confirma la transferencia del GPS a este dispositivo.' });
    try {
      const result = await deliveryOrderService.transferTrackingDevice({
        driverId: req.user.id,
        actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
      });
      res.json(result);
    } catch (error) {
      sendDomainError(res, error, 'No fue posible transferir el dispositivo GPS');
    }
  });

  app.post('/api/pedidos/delivery/native/bootstrap', authenticateToken, requireDeliveryUser, async (req, res) => {
    const deviceId = requestDeviceId(req);
    const { rows } = await pool.query(`
      SELECT shift_active, tracking_device_id
      FROM pedidos_app_delivery_profiles
      WHERE user_id=$1
    `, [req.user.id]);
    if (!rows[0]?.shift_active) return res.status(409).json({ code: 'SHIFT_NOT_ACTIVE', error: 'Inicia el turno antes de activar el servicio nativo.' });
    if (rows[0].tracking_device_id !== deviceId) {
      return res.status(409).json({ code: 'TRACKING_ACTIVE_ON_ANOTHER_DEVICE', error: 'Este dispositivo no controla el GPS del turno.' });
    }
    const bootstrapCode = crypto.randomBytes(32).toString('base64url');
    const codeHash = crypto.createHash('sha256').update(bootstrapCode).digest('hex');
    await pool.query(`
      INSERT INTO pedidos_app_delivery_native_bootstrap
        (code_hash,driver_id,device_id,expires_at)
      VALUES ($1,$2,$3,NOW()+INTERVAL '90 seconds')
    `, [codeHash, req.user.id, deviceId]);
    res.json({ status: 'ok', bootstrapCode, expiresInSeconds: 90 });
  });

  app.post('/api/pedidos/delivery/native/exchange', trackingLimiter, async (req, res) => {
    const code = String(req.body.bootstrapCode || '').trim();
    const deviceId = String(req.body.deviceId || '').trim().slice(0, 100);
    if (!code || !deviceId) return res.status(400).json({ code: 'NATIVE_BOOTSTRAP_REQUIRED', error: 'Código y dispositivo son obligatorios.' });
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bootstrap = await client.query(`
        SELECT bootstrap.driver_id,bootstrap.device_id,bootstrap.expires_at,bootstrap.consumed_at,
               profile.shift_active,profile.tracking_device_id
        FROM pedidos_app_delivery_native_bootstrap bootstrap
        JOIN pedidos_app_delivery_profiles profile ON profile.user_id=bootstrap.driver_id
        WHERE bootstrap.code_hash=$1
        FOR UPDATE OF bootstrap
      `, [codeHash]);
      const record = bootstrap.rows[0];
      if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= Date.now()
          || record.device_id !== deviceId || !record.shift_active || record.tracking_device_id !== deviceId) {
        await client.query('ROLLBACK');
        return res.status(401).json({ code: 'NATIVE_BOOTSTRAP_INVALID', error: 'El código nativo expiró o no corresponde a este dispositivo.' });
      }
      await client.query('UPDATE pedidos_app_delivery_native_bootstrap SET consumed_at=NOW() WHERE code_hash=$1', [codeHash]);
      await client.query('COMMIT');
      const trackingToken = jwt.sign({
        type: 'delivery_tracking', id: record.driver_id, deviceId,
      }, trackingSecret, { audience: 'delivery-location', issuer: 'distrito-api', expiresIn: '12h' });
      return res.json({ status: 'ok', trackingToken, expiresInSeconds: 12 * 60 * 60 });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ code: 'NATIVE_BOOTSTRAP_FAILED', error: 'No fue posible activar el seguimiento nativo.' });
    } finally {
      client.release();
    }
  });

  const authenticateNativeTracking = (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      const payload = jwt.verify(token, trackingSecret, { audience: 'delivery-location', issuer: 'distrito-api' });
      if (payload.type !== 'delivery_tracking' || !payload.id || !payload.deviceId) throw new Error('invalid scope');
      req.nativeDelivery = payload;
      next();
    } catch {
      res.status(401).json({ code: 'TRACKING_TOKEN_INVALID', error: 'La autorización nativa de ubicación no es válida.' });
    }
  };

  const ingestLocations = async (req, res, identity) => {
    try {
      const result = await deliveryLocationService.ingestBatch({
        driverId: identity.driverId,
        deviceId: identity.deviceId,
        points: req.body.points,
      });
      await publishLocationResult(identity.driverId, result);
      res.status(202).json(result);
    } catch (error) {
      sendDomainError(res, error, 'No fue posible sincronizar las posiciones GPS');
    }
  };

  app.post('/api/pedidos/delivery/location/batch', authenticateToken, requireDeliveryUser, async (req, res) => (
    ingestLocations(req, res, { driverId: req.user.id, deviceId: requestDeviceId(req) })
  ));

  app.post('/api/pedidos/delivery/native/location/batch', authenticateNativeTracking, async (req, res) => (
    ingestLocations(req, res, { driverId: req.nativeDelivery.id, deviceId: req.nativeDelivery.deviceId })
  ));

  app.post('/api/pedidos/delivery/availability', authenticateToken, requireDeliveryUser, async (req, res) => {
    return res.status(410).json({
      code: 'AVAILABILITY_REPLACED_BY_SHIFT',
      error: 'La disponibilidad ahora se controla con Iniciar turno y Finalizar turno.',
    });
  });

  app.get('/api/pedidos/delivery/orders/available', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const operation = await pool.query(`
        SELECT shift_active, last_seen_at, tracking_device_id,
               (SELECT COUNT(*)::int FROM pedidos_app_orders committed
                WHERE committed.delivery_user_id=$1
                  AND COALESCE(committed.delivery_provider_type,'own')='own'
                  AND committed.delivery_status IN ('Pendiente','Aceptado','Recogido','En camino')) AS committed_orders
        FROM pedidos_app_delivery_profiles WHERE user_id=$1
      `, [req.user.id]);
      if (!operation.rows[0]?.shift_active) {
        return res.json({ status: 'ok', capacity: req.deliveryUser.max_active_orders, committed: 0, orders: [], shiftActive: false });
      }
      const { rows } = await pool.query(`${orderSelect}
        WHERE lower(order_data.delivery_type) = 'domicilio'
          AND order_data.status = 'Listo'
          AND order_data.delivery_status = 'Pendiente'
          AND (order_data.delivery_user_id IS NULL OR order_data.delivery_user_id = $1)
        ORDER BY order_data.created_at ASC
        LIMIT 100
      `, [req.user.id]);
      res.json({
        status: 'ok', capacity: req.deliveryUser.max_active_orders,
        committed: Number(operation.rows[0].committed_orders || 0), shiftActive: true,
        orders: rows.map(formatAvailableOrder),
      });
    } catch (error) {
      console.error('Error cargando pedidos disponibles:', error);
      res.status(500).json({ error: 'No fue posible cargar los pedidos disponibles' });
    }
  });

  app.get('/api/pedidos/delivery/orders/current', authenticateToken, requireDeliveryUser, async (req, res) => {
    const { rows } = await pool.query(`${orderSelect}
      WHERE order_data.delivery_user_id = $1
        AND order_data.delivery_status = ANY($2::text[])
      ORDER BY order_data.created_at ASC
    `, [req.user.id, ['Aceptado', 'Recogido', 'En camino']]);
    res.json({ status: 'ok', capacity: req.deliveryUser.max_active_orders, orders: rows.map(formatOrder) });
  });

  app.get('/api/pedidos/delivery/orders/:id', authenticateToken, requireDeliveryUser, async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Pedido inválido' });
    const { rows } = await pool.query(`${orderSelect}
      WHERE order_data.id = $1
        AND (
          order_data.delivery_user_id = $2
          OR (
            order_data.delivery_user_id IS NULL
            AND order_data.status = 'Listo'
            AND order_data.delivery_status = 'Pendiente'
          )
        )
    `, [orderId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido no disponible' });
    const ownsOrder = Number(rows[0].delivery_user_id) === Number(req.user.id);
    let driverTrail = [];
    if (ownsOrder && ['Recogido', 'En camino'].includes(rows[0].delivery_status)) {
      const trailResult = await pool.query(`
        SELECT latitude, longitude, accuracy, captured_at AS "recordedAt"
        FROM pedidos_app_driver_location_points
        WHERE driver_id = $1
          AND captured_at >= COALESCE($2::timestamptz, captured_at)
          AND captured_at <= COALESCE($3::timestamptz, NOW())
        ORDER BY captured_at DESC
        LIMIT 120
      `, [req.user.id, rows[0].picked_up_at || rows[0].on_the_way_at, rows[0].delivery_completed_at]);
      driverTrail = trailResult.rows.reverse().map((point) => ({
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
        accuracy: point.accuracy == null ? null : Number(point.accuracy),
        recordedAt: point.recordedAt,
      }));
    }
    res.json({
      status: 'ok',
      order: ownsOrder ? formatOrder(rows[0], { driverTrail }) : formatAvailableOrder(rows[0]),
    });
  });

  app.post('/api/pedidos/delivery/orders/:id/accept', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId)) return res.status(400).json({ code: 'INVALID_ORDER_ID', error: 'Pedido inválido' });
      const result = await deliveryOrderService.acceptOrder({
        orderId,
        driverId: req.user.id,
        actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
      });
      res.json({ status: 'ok', order: formatOrder(result.order), replayed: result.replayed });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible aceptar el pedido');
    }
  });

  app.post('/api/pedidos/delivery/orders/:id/pickup', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const result = await deliveryOrderService.startDelivery({
        orderId: Number(req.params.id), driverId: req.user.id, actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
      });
      res.json({ status: 'ok', order: formatOrder(result.order), replayed: result.replayed });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible iniciar la entrega');
    }
  });

  app.post('/api/pedidos/delivery/orders/:id/location', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const result = await deliveryLocationService.ingestBatch({
        driverId: req.user.id,
        deviceId: requestDeviceId(req),
        points: [{
          id: req.body.pointId,
          latitude: req.body.latitude, longitude: req.body.longitude,
          accuracy: req.body.accuracy, speed: req.body.speed,
          bearing: req.body.heading, altitude: req.body.altitude,
          capturedAt: req.body.capturedAt || new Date().toISOString(),
          provider: 'web-compat',
        }],
      });
      if (!result.orderIds.includes(orderId)) {
        return res.status(409).json({ code: 'ORDER_NOT_TRACKING', error: 'Este pedido no está compartiendo ubicación.' });
      }
      await publishLocationResult(req.user.id, result);
      res.status(202).json({ status: 'ok', arrival: result.arrivals[orderId], duplicated: result.duplicated });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible registrar la ubicación');
    }
  });

  app.post('/api/pedidos/delivery/orders/:id/complete', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const result = await deliveryOrderService.completeDelivery({
        orderId: Number(req.params.id), driverId: req.user.id, actor: req.user,
        deviceId: requestDeviceId(req),
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
        completion: req.body,
      });
      res.json({ status: 'ok', order: formatOrder(result.order), arrival: result.arrival, replayed: result.replayed });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible finalizar la entrega');
    }
  });

  app.get('/api/pedidos/delivery/history', authenticateToken, requireDeliveryUser, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    const { rows } = await pool.query(`${orderSelect}
      WHERE order_data.delivery_user_id = $1
        AND order_data.delivery_status = ANY($2::text[])
      ORDER BY order_data.delivery_completed_at DESC NULLS LAST, order_data.updated_at DESC
      LIMIT $3
    `, [req.user.id, FINAL_DELIVERY_STATUSES, limit]);
    res.json({ status: 'ok', orders: rows.map(formatOrder) });
  });

  app.get('/api/pedidos/delivery/stats', authenticateToken, requireDeliveryUser, async (req, res) => {
    const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'week';
    const interval = range === 'day' ? '1 day' : range === 'month' ? '30 days' : '7 days';
    const [summary, daily, hourly] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS deliveries,
               COALESCE(SUM(delivery_fee), 0)::numeric AS delivery_value,
               COALESCE((SELECT SUM(point.distance_from_previous_km)
                         FROM pedidos_app_driver_location_points point
                         WHERE point.driver_id=$1 AND point.captured_at >= NOW()-$2::interval),0)::numeric AS kilometers,
               COALESCE(AVG(delivery_duration_seconds), 0)::numeric AS average_seconds,
               COALESCE(AVG(delivery_rating), 0)::numeric AS average_rating,
               COALESCE(AVG(EXTRACT(EPOCH FROM (delivery_accepted_at-created_at)))
                        FILTER (WHERE delivery_accepted_at IS NOT NULL),0)::numeric AS ready_to_accept_seconds,
               COALESCE(AVG(EXTRACT(EPOCH FROM (picked_up_at-delivery_accepted_at)))
                        FILTER (WHERE picked_up_at IS NOT NULL AND delivery_accepted_at IS NOT NULL),0)::numeric AS accept_to_pickup_seconds,
               COALESCE(AVG(EXTRACT(EPOCH FROM (delivery_completed_at-picked_up_at)))
                        FILTER (WHERE delivery_completed_at IS NOT NULL AND picked_up_at IS NOT NULL),0)::numeric AS transport_seconds
        FROM pedidos_app_orders
        WHERE delivery_user_id = $1 AND delivery_status = 'Entregado'
          AND delivery_completed_at >= NOW() - $2::interval
      `, [req.user.id, interval]),
      pool.query(`
        SELECT TO_CHAR((delivery_completed_at AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS label,
               COUNT(*)::int AS deliveries, COALESCE(SUM(delivery_fee), 0)::numeric AS income
        FROM pedidos_app_orders
        WHERE delivery_user_id = $1 AND delivery_status = 'Entregado'
          AND delivery_completed_at >= NOW() - $2::interval
        GROUP BY 1 ORDER BY 1
      `, [req.user.id, interval]),
      pool.query(`
        SELECT EXTRACT(HOUR FROM delivery_completed_at AT TIME ZONE 'America/Bogota')::int AS hour,
               COUNT(*)::int AS deliveries
        FROM pedidos_app_orders
        WHERE delivery_user_id = $1 AND delivery_status = 'Entregado'
          AND delivery_completed_at >= NOW() - $2::interval
        GROUP BY 1 ORDER BY 1
      `, [req.user.id, interval]),
    ]);
    const data = summary.rows[0];
    res.json({
      status: 'ok',
      range,
      summary: {
        deliveries: Number(data.deliveries),
        deliveryValue: Number(data.delivery_value), income: Number(data.delivery_value),
        kilometers: Number(data.kilometers),
        averageSeconds: Number(data.average_seconds), averageRating: Number(data.average_rating),
        readyToAcceptSeconds: Number(data.ready_to_accept_seconds),
        acceptToPickupSeconds: Number(data.accept_to_pickup_seconds),
        transportSeconds: Number(data.transport_seconds),
      },
      daily: daily.rows.map((row) => ({ label: row.label, deliveries: Number(row.deliveries), income: Number(row.income) })),
      hourly: hourly.rows.map((row) => ({ hour: Number(row.hour), deliveries: Number(row.deliveries) })),
    });
  });

  app.post('/api/pedidos/delivery/push/subscribe', authenticateToken, requireDeliveryUser, async (req, res) => {
    const subscription = req.body.subscription;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
    await pool.query(`
      INSERT INTO pedidos_app_push_subscriptions (endpoint, subscription_json, user_id, audience, updated_at)
      VALUES ($1, $2, $3, 'delivery', NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        subscription_json = EXCLUDED.subscription_json,
        user_id = EXCLUDED.user_id,
        audience = 'delivery', updated_at = NOW()
    `, [subscription.endpoint, JSON.stringify(subscription), req.user.id]);
    res.status(201).json({ status: 'ok' });
  });

  app.delete('/api/pedidos/delivery/push/subscribe', authenticateToken, requireDeliveryUser, async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (endpoint) {
      await pool.query('DELETE FROM pedidos_app_push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    } else {
      await pool.query("DELETE FROM pedidos_app_push_subscriptions WHERE user_id = $1 AND audience = 'delivery'", [req.user.id]);
    }
    res.json({ status: 'ok' });
  });

  app.get('/api/pedidos/admin/delivery/overview', authenticateToken, requirePermission('Domicilios', 'ver'), async (req, res) => {
    const [drivers, orders, settings] = await Promise.all([
      pool.query(`
        SELECT u.id, u.username, TRIM(CONCAT(u.name, ' ', u.last_name)) AS name, u.phone, u.photo_url,
               profile.vehicle_name, profile.vehicle_type, profile.plate,
               profile.max_active_orders,
               profile.current_latitude, profile.current_longitude, profile.current_accuracy,
               profile.last_location_at, profile.connected_at, profile.last_seen_at,
               profile.shift_active, profile.shift_started_at, profile.tracking_mode,
               profile.tracking_device_id, profile.gps_status,
               CASE
                 WHEN profile.shift_active
                   AND profile.last_seen_at >= NOW() - make_interval(secs => COALESCE(settings.presence_timeout_seconds,90))
                   THEN CASE WHEN COALESCE(active_order.active_order_count,0)>0 THEN 'Ocupado' ELSE 'Libre' END
                 ELSE 'Desconectado'
               END AS live_status,
               CASE WHEN profile.rating_count > 0 THEN ROUND(profile.rating_sum / profile.rating_count, 2) ELSE 0 END AS rating,
               active_order.id AS active_order_id,
               active_order.delivery_status AS active_order_status,
               active_order.customer_name AS active_customer,
               active_order.address AS active_address,
               active_order.delivery_latitude AS active_destination_latitude,
               active_order.delivery_longitude AS active_destination_longitude,
               COALESCE(active_order.active_order_count, 0)::int AS active_order_count,
               (
                 SELECT COALESCE(json_agg(
                   json_build_object(
                     'id', o.id,
                     'status', o.delivery_status,
                     'customer_name', o.customer_name,
                     'address', o.address,
                     'latitude', o.delivery_latitude,
                     'longitude', o.delivery_longitude
                   ) ORDER BY o.created_at ASC
                 ), '[]'::json)
                 FROM pedidos_app_orders o
                  WHERE o.delivery_user_id = u.id
                    AND COALESCE(o.delivery_provider_type,'own')='own'
                    AND o.delivery_status IN ('Pendiente','Aceptado','Recogido','En camino')
               ) AS active_orders
        FROM pedidos_app_users u
        JOIN pedidos_app_roles role ON role.id = u.role_id AND role.name IN ('Domiciliario', 'Repartidor')
        LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        LEFT JOIN pedidos_app_settings settings ON settings.id=1
        LEFT JOIN LATERAL (
          SELECT id, delivery_status, customer_name, address, delivery_latitude, delivery_longitude,
                 COUNT(*) OVER ()::int AS active_order_count
          FROM pedidos_app_orders
          WHERE delivery_user_id = u.id AND COALESCE(delivery_provider_type,'own')='own'
            AND delivery_status IN ('Pendiente','Aceptado','Recogido','En camino')
          ORDER BY created_at ASC LIMIT 1
        ) active_order ON TRUE
        WHERE u.status = 'Activo'
        ORDER BY live_status, name
      `),
      pool.query(`${orderSelect}
        WHERE lower(order_data.delivery_type) = 'domicilio'
          AND order_data.status = 'Listo'
          AND order_data.delivery_status = 'Pendiente'
          AND order_data.delivery_user_id IS NULL
        ORDER BY order_data.created_at ASC
      `),
      pool.query(`
        SELECT restaurant_name, COALESCE(kitchen_address, address) AS address,
               store_latitude, store_longitude
        FROM pedidos_app_settings
        WHERE id = 1
      `),
    ]);
    const liveDrivers = drivers.rows;
    const restaurant = settings.rows[0] || {};
    res.json({
      status: 'ok',
      drivers: liveDrivers,
      orders: orders.rows.map(formatOrder),
      store: {
        name: restaurant.restaurant_name || 'Distrito BG',
        address: restaurant.address || 'Valledupar, Colombia',
        latitude: Number(restaurant.store_latitude ?? 10.4631),
        longitude: Number(restaurant.store_longitude ?? -73.2532),
      },
    });
  });

  app.post('/api/pedidos/admin/delivery/orders/:id/assign', authenticateToken, requirePermission('Domicilios', 'asignar'), async (req, res) => {
    const orderId = Number(req.params.id);
    const userId = Number(req.body.userId);
    if (!Number.isInteger(orderId) || !Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Selecciona un domiciliario activo para asignar el pedido' });
    }
    try {
      const result = await deliveryOrderService.reserveOrder({
        orderId, driverId: userId, actor: req.user,
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
      });
      sendPush({ userId, title: 'Nuevo pedido asignado', body: `Tienes asignado el pedido #${orderId}`, url: `/pedidos/${orderId}` })
        .catch((error) => console.error('Error enviando push de asignación:', error));
      res.json({ status: 'ok', order: formatOrder(result.order), replayed: result.replayed });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible asignar el pedido');
    }
  });

  app.post('/api/pedidos/admin/delivery/drivers/:id/shift/end', authenticateToken, requirePermission('Domicilios', 'forzar_turno'), async (req, res) => {
    try {
      const result = await deliveryOrderService.endShift({
        driverId: Number(req.params.id), actor: req.user, deviceId: 'admin-force',
        idempotencyKey: req.headers['idempotency-key'] || req.body.operationId,
        forced: true, reason: req.body.reason,
      });
      res.json(result);
    } catch (error) {
      sendDomainError(res, error, 'No fue posible forzar el fin del turno');
    }
  });

  app.post('/api/pedidos/admin/delivery/orders/:id/geofence-override', authenticateToken, requirePermission('Domicilios', 'override_geocerca'), async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ code: 'GEOFENCE_OVERRIDE_REASON_REQUIRED', error: 'Explica el motivo de la excepción con al menos 10 caracteres.' });
    try {
      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_delivery_geofence_overrides
          (order_id,authorized_by,driver_id,reason,exception_type,latitude,longitude,distance_meters)
        SELECT order_data.id,$2,order_data.delivery_user_id,$3,$4,
               profile.current_latitude,profile.current_longitude,
               CASE WHEN order_data.delivery_latitude IS NOT NULL AND profile.current_latitude IS NOT NULL
                 THEN ROUND(6371000 * 2 * ASIN(SQRT(
                   POWER(SIN(RADIANS((order_data.delivery_latitude-profile.current_latitude)/2)),2)+
                   COS(RADIANS(profile.current_latitude))*COS(RADIANS(order_data.delivery_latitude))*
                   POWER(SIN(RADIANS((order_data.delivery_longitude-profile.current_longitude)/2)),2)
                 )))::integer ELSE NULL END
        FROM pedidos_app_orders order_data
        LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id=order_data.delivery_user_id
        WHERE order_data.id=$1 AND order_data.delivery_status='En camino'
        RETURNING *
      `, [Number(req.params.id), req.user.id, reason, req.body.exceptionType || 'manual_admin']);
      if (!rows.length) return res.status(409).json({ code: 'INVALID_ORDER_STATE', error: 'La excepción solo puede autorizarse para una entrega en camino.' });
      await pool.query(`
        INSERT INTO pedidos_app_audit_logs
          (user_id,username_attempted,module,action,details,request_data)
        VALUES ($1,$2,'Domicilios','Override geocerca',$3,$4::jsonb)
      `, [req.user.id, req.user.username || null, `Excepción de geocerca para pedido #${req.params.id}`, JSON.stringify({
        overrideId: rows[0].id, orderId: Number(req.params.id), reason,
        distanceMeters: rows[0].distance_meters,
      })]);
      res.status(201).json({ status: 'ok', override: rows[0] });
    } catch (error) {
      sendDomainError(res, error, 'No fue posible autorizar la excepción de geocerca');
    }
  });

  app.get('/api/pedidos/admin/delivery/orders/:id/evidence', authenticateToken, requirePermission('Domicilios', 'ver'), async (req, res) => {
    const { rows } = await pool.query(`
      SELECT mime_type, contents, sha256 FROM pedidos_app_delivery_evidence_files WHERE order_id=$1
    `, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Este pedido no tiene evidencia fotográfica.' });
    res.set('Content-Type', rows[0].mime_type);
    res.set('ETag', `"${rows[0].sha256}"`);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(rows[0].contents);
  });

  return {
    publish: realtime.publish,
    sendPush,
  };
};
