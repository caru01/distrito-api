const bcrypt = require('bcryptjs');
const {
  CARRYING_DELIVERY_STATUSES,
  DELIVERY_ROLES,
  FINAL_DELIVERY_STATUSES,
} = require('./src/delivery-rules');

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

function haversineKilometers(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latDistance = radians(toLatitude - fromLatitude);
  const lonDistance = radians(toLongitude - fromLongitude);
  const value = Math.sin(latDistance / 2) ** 2
    + Math.cos(radians(fromLatitude)) * Math.cos(radians(toLatitude)) * Math.sin(lonDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const DEFAULT_COMPLETION_RADIUS_METERS = 150;
const MAX_GPS_ACCURACY_METERS = 200;
const MAX_GPS_AGE_MS = 3 * 60 * 1000;

function completionRadius(value) {
  const radius = Number(value);
  return Number.isInteger(radius) && radius >= 50 && radius <= 500
    ? radius
    : DEFAULT_COMPLETION_RADIUS_METERS;
}

function buildArrivalStatus({
  destinationLatitude, destinationLongitude, latitude, longitude, accuracy,
  locationAt, acceptedAt, radiusMeters,
}) {
  const radius = completionRadius(radiusMeters);
  const hasExactDestination = destinationLatitude != null && destinationLongitude != null;
  if (!hasExactDestination) {
    return {
      required: false,
      hasExactDestination: false,
      distanceMeters: null,
      radiusMeters: radius,
      hasCurrentLocation: latitude != null && longitude != null,
      isFresh: false,
      accuracyMeters: accuracy == null ? null : Math.round(Number(accuracy)),
      isAccuracyAcceptable: true,
      isWithinRange: true,
    };
  }

  const hasCurrentLocation = latitude != null && longitude != null
    && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
  const locationTime = locationAt ? new Date(locationAt).getTime() : NaN;
  const acceptedTime = acceptedAt ? new Date(acceptedAt).getTime() : NaN;
  const isFresh = hasCurrentLocation
    && Number.isFinite(locationTime)
    && Date.now() - locationTime <= MAX_GPS_AGE_MS
    && (!Number.isFinite(acceptedTime) || locationTime >= acceptedTime);
  const numericAccuracy = accuracy == null ? null : Number(accuracy);
  const isAccuracyAcceptable = numericAccuracy == null
    || (Number.isFinite(numericAccuracy) && numericAccuracy <= MAX_GPS_ACCURACY_METERS);
  const distanceMeters = hasCurrentLocation
    ? Math.round(haversineKilometers(
      Number(latitude), Number(longitude), Number(destinationLatitude), Number(destinationLongitude),
    ) * 1000)
    : null;

  return {
    required: true,
    hasExactDestination: true,
    distanceMeters,
    radiusMeters: radius,
    hasCurrentLocation,
    isFresh,
    accuracyMeters: numericAccuracy == null ? null : Math.round(numericAccuracy),
    isAccuracyAcceptable,
    isWithinRange: isFresh && isAccuracyAcceptable && distanceMeters != null && distanceMeters <= radius,
  };
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
    acceptedAt: row.delivery_accepted_at,
    radiusMeters: row.delivery_completion_radius_meters,
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
    const packet = `event: ${event}\ndata: ${JSON.stringify({ ...payload, emittedAt: new Date().toISOString() })}\n\n`;
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

  return { add, publish, onlineUserIds };
}

module.exports = function registerDeliveryApi(app, dependencies) {
  const {
    pool, authenticateToken, requirePermission, trackingLimiter, webpush,
    publicVapidKey, minPasswordLength, authorizeTrackingAccess, trackingSecret,
  } = dependencies;
  const realtime = createRealtimeHub();

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

  const orderSelect = `
    SELECT order_data.*,
           settings.delivery_cost AS configured_delivery_fee,
           settings.delivery_completion_radius_meters,
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
    FROM pedidos_app_orders order_data
    LEFT JOIN pedidos_app_settings settings ON settings.id = 1
    LEFT JOIN pedidos_app_users driver ON driver.id = order_data.delivery_user_id
    LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = order_data.delivery_user_id
  `;

  app.get('/api/pedidos/push/public-key', (req, res) => {
    res.json({ status: 'ok', publicKey: publicVapidKey });
  });

  app.get('/api/pedidos/realtime/stream', authenticateToken, (req, res) => {
    realtime.add(req, res, {
      kind: 'authenticated', userId: req.user.id, role: req.user.role,
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
        INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status, connected_at)
        VALUES ($1, 'Libre', NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET connected_at = NOW(),
            availability_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = EXCLUDED.user_id
                  AND active_order.delivery_status IN ('Aceptado', 'Recogido', 'En camino')
              ) THEN 'Ocupado'
              WHEN pedidos_app_delivery_profiles.availability_status = 'Desconectado' THEN 'Libre'
              ELSE pedidos_app_delivery_profiles.availability_status
            END,
            updated_at = NOW()
      `, [req.user.id]);
      const { rows } = await pool.query(`
        SELECT u.id, u.username, u.name, u.last_name, u.document, u.email, u.phone, u.photo_url,
               profile.vehicle_name, profile.vehicle_type, profile.plate, profile.documents,
               profile.availability_status, profile.max_active_orders,
               (SELECT COUNT(*)::int FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = u.id
                  AND active_order.delivery_status = ANY($2::text[])) AS active_orders,
               CASE WHEN profile.rating_count > 0 THEN ROUND(profile.rating_sum / profile.rating_count, 2) ELSE 0 END AS rating
        FROM pedidos_app_users u
        JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        WHERE u.id = $1
      `, [req.user.id, CARRYING_DELIVERY_STATUSES]);
      res.json({ status: 'ok', profile: rows[0] });
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

  app.post('/api/pedidos/delivery/availability', authenticateToken, requireDeliveryUser, async (req, res) => {
    const requested = req.body.status;
    if (!['Libre', 'Desconectado'].includes(requested)) return res.status(400).json({ error: 'Estado no permitido' });
    const active = await pool.query(`
      SELECT 1 FROM pedidos_app_orders
      WHERE delivery_user_id = $1 AND delivery_status = ANY($2::text[])
      LIMIT 1
    `, [req.user.id, ['Aceptado', 'Recogido', 'En camino']]);
    if (active.rowCount && requested === 'Libre') return res.status(409).json({ error: 'Termina el pedido activo antes de marcarte libre' });
    await pool.query(`
      INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status, connected_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET availability_status = $2, updated_at = NOW()
    `, [req.user.id, requested]);
    realtime.publish('driver_presence', { userId: req.user.id, status: requested });
    res.json({ status: 'ok' });
  });

  app.get('/api/pedidos/delivery/orders/available', authenticateToken, requireDeliveryUser, async (req, res) => {
    try {
      const { rows } = await pool.query(`${orderSelect}
        WHERE lower(order_data.delivery_type) = 'domicilio'
          AND order_data.status = 'Listo'
          AND order_data.delivery_status = 'Pendiente'
          AND (order_data.delivery_user_id IS NULL OR order_data.delivery_user_id = $1)
        ORDER BY order_data.created_at ASC
        LIMIT 100
      `, [req.user.id]);
      res.json({ status: 'ok', capacity: req.deliveryUser.max_active_orders, orders: rows.map(formatOrder) });
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
    let driverTrail = [];
    if (Number(rows[0].delivery_user_id) === Number(req.user.id) && rows[0].delivery_status === 'En camino') {
      const trailResult = await pool.query(`
        SELECT latitude, longitude, accuracy, recorded_at AS "recordedAt"
        FROM pedidos_app_delivery_locations
        WHERE order_id = $1 AND user_id = $2
          AND recorded_at >= COALESCE($3::timestamptz, recorded_at)
        ORDER BY recorded_at DESC
        LIMIT 120
      `, [orderId, req.user.id, rows[0].delivery_accepted_at]);
      driverTrail = trailResult.rows.reverse().map((point) => ({
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
        accuracy: point.accuracy == null ? null : Number(point.accuracy),
        recordedAt: point.recordedAt,
      }));
    }
    res.json({ status: 'ok', order: formatOrder(rows[0], { driverTrail }) });
  });

  app.post('/api/pedidos/delivery/orders/:id/accept', authenticateToken, requireDeliveryUser, async (req, res) => {
    const client = await pool.connect();
    try {
      const orderId = Number(req.params.id);
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status, connected_at)
        VALUES ($1, 'Libre', NOW())
        ON CONFLICT (user_id) DO NOTHING
      `, [req.user.id]);
      const capacityResult = await client.query(`
        SELECT profile.max_active_orders,
               (SELECT COUNT(*)::int
                FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = profile.user_id
                  AND active_order.delivery_status = ANY($2::text[])) AS active_orders
        FROM pedidos_app_delivery_profiles profile
        WHERE profile.user_id = $1
        FOR UPDATE
      `, [req.user.id, CARRYING_DELIVERY_STATUSES]);
      const capacity = Number(capacityResult.rows[0]?.max_active_orders || 1);
      const activeOrders = Number(capacityResult.rows[0]?.active_orders || 0);
      if (activeOrders >= capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DELIVERY_CAPACITY_REACHED',
          error: `Alcanzaste tu capacidad de ${capacity} pedido${capacity === 1 ? '' : 's'} simultáneo${capacity === 1 ? '' : 's'}. Finaliza uno antes de aceptar otro.`,
          activeOrders,
          capacity,
        });
      }
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_user_id = $1,
            delivery_status = 'En camino',
            status = 'En camino',
            delivery_accepted_at = COALESCE(delivery_accepted_at, NOW()),
            picked_up_at = COALESCE(picked_up_at, NOW()),
            on_the_way_at = COALESCE(on_the_way_at, NOW()),
            updated_at = NOW()
        WHERE id = $2
          AND lower(delivery_type) = 'domicilio'
          AND status = 'Listo'
          AND delivery_status = 'Pendiente'
          AND (delivery_user_id IS NULL OR delivery_user_id = $1)
        RETURNING *
      `, [req.user.id, orderId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Otro domiciliario ya tomó este pedido o ya no está disponible' });
      }
      await client.query(`
        INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status, connected_at)
        VALUES ($1, 'Ocupado', NOW())
        ON CONFLICT (user_id) DO UPDATE SET availability_status = 'Ocupado', updated_at = NOW()
      `, [req.user.id]);
      await client.query('COMMIT');
      realtime.publish('order_assigned', { orderId, deliveryUserId: req.user.id });
      realtime.publish('order_updated', {
        orderId,
        deliveryUserId: req.user.id,
        deliveryStatus: 'En camino',
        orderStatus: 'En camino',
      });
      res.json({ status: 'ok', order: formatOrder(rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error aceptando pedido:', error);
      if (error.code === '23505') return res.status(409).json({ error: 'Otro domiciliario ya tomó este pedido' });
      res.status(500).json({ error: 'No fue posible aceptar el pedido' });
    } finally {
      client.release();
    }
  });

  app.post('/api/pedidos/delivery/orders/:id/pickup', authenticateToken, requireDeliveryUser, async (req, res) => {
    const { rows } = await pool.query(`
      UPDATE pedidos_app_orders
      SET delivery_status = 'En camino', status = 'En camino',
          picked_up_at = COALESCE(picked_up_at, NOW()),
          on_the_way_at = COALESCE(on_the_way_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND delivery_user_id = $2 AND delivery_status IN ('Aceptado', 'Recogido')
      RETURNING *
    `, [Number(req.params.id), req.user.id]);
    if (!rows.length) return res.status(409).json({ error: 'El pedido no se puede marcar como recogido' });
    realtime.publish('order_updated', { orderId: rows[0].id, deliveryStatus: 'En camino', orderStatus: 'En camino' });
    res.json({ status: 'ok', order: formatOrder(rows[0]) });
  });

  app.post('/api/pedidos/delivery/orders/:id/location', authenticateToken, requireDeliveryUser, async (req, res) => {
    const orderId = Number(req.params.id);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const accuracy = req.body.accuracy == null ? null : Number(req.body.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Ubicación inválida' });
    }
    const client = await pool.connect();
    let arrival;
    try {
      await client.query('BEGIN');
      const ownsOrder = await client.query(`
        SELECT order_data.id, order_data.delivery_latitude, order_data.delivery_longitude,
               order_data.delivery_accepted_at, settings.delivery_completion_radius_meters
        FROM pedidos_app_orders order_data
        LEFT JOIN pedidos_app_settings settings ON settings.id = 1
        WHERE order_data.id = $1 AND order_data.delivery_user_id = $2 AND order_data.delivery_status = 'En camino'
        FOR UPDATE OF order_data
      `, [orderId, req.user.id]);
      if (!ownsOrder.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Este pedido no está compartiendo ubicación' });
      }
      const previous = await client.query(`
        SELECT latitude, longitude
        FROM pedidos_app_delivery_locations
        WHERE order_id = $1 AND user_id = $2
        ORDER BY recorded_at DESC LIMIT 1
      `, [orderId, req.user.id]);
      let traveled = 0;
      if (previous.rowCount && (accuracy == null || accuracy <= 200)) {
        traveled = haversineKilometers(
          Number(previous.rows[0].latitude), Number(previous.rows[0].longitude), latitude, longitude,
        );
        if (!Number.isFinite(traveled) || traveled > 3) traveled = 0;
      }
      await client.query(`
        INSERT INTO pedidos_app_delivery_locations
          (user_id, order_id, latitude, longitude, accuracy, speed, heading)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [req.user.id, orderId, latitude, longitude, accuracy, req.body.speed ?? null, req.body.heading ?? null]);
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET current_latitude = $1, current_longitude = $2, current_accuracy = $3,
            last_location_at = NOW(), availability_status = 'Ocupado', updated_at = NOW()
        WHERE user_id = $4
      `, [latitude, longitude, accuracy, req.user.id]);
      if (traveled > 0) {
        await client.query(`
          UPDATE pedidos_app_orders
          SET delivery_distance_km = COALESCE(delivery_distance_km, 0) + $1
          WHERE id = $2
        `, [traveled, orderId]);
      }
      arrival = buildArrivalStatus({
        destinationLatitude: ownsOrder.rows[0].delivery_latitude,
        destinationLongitude: ownsOrder.rows[0].delivery_longitude,
        latitude,
        longitude,
        accuracy,
        locationAt: new Date(),
        acceptedAt: ownsOrder.rows[0].delivery_accepted_at,
        radiusMeters: ownsOrder.rows[0].delivery_completion_radius_meters,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error registrando ubicación delivery:', error);
      return res.status(500).json({ error: 'No fue posible registrar la ubicación' });
    } finally {
      client.release();
    }
    realtime.publish('delivery_location', { orderId, deliveryUserId: req.user.id, latitude, longitude, accuracy }, (connectedClient) => {
      if (connectedClient.kind === 'tracking') return connectedClient.orderId === orderId;
      if (DELIVERY_ROLES.has(connectedClient.role)) return Number(connectedClient.userId) === Number(req.user.id);
      return true;
    });
    res.status(202).json({ status: 'ok', arrival });
  });

  app.post('/api/pedidos/delivery/orders/:id/complete', authenticateToken, requireDeliveryUser, async (req, res) => {
    if (req.body.confirmReceived !== true) return res.status(400).json({ error: 'Debes confirmar que el cliente recibió el pedido' });
    const rating = req.body.rating == null || req.body.rating === '' ? null : Number(req.body.rating);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return res.status(400).json({ error: 'Calificación inválida' });
    const evidence = req.body.evidence || null;
    if (evidence && String(evidence).length > 2_800_000) return res.status(413).json({ error: 'La fotografía supera el límite de 2 MB' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const completionOrder = await client.query(`
        SELECT order_data.id, order_data.delivery_latitude, order_data.delivery_longitude,
               order_data.delivery_accepted_at, settings.delivery_completion_radius_meters
        FROM pedidos_app_orders order_data
        LEFT JOIN pedidos_app_settings settings ON settings.id = 1
        WHERE order_data.id = $1 AND order_data.delivery_user_id = $2
          AND order_data.delivery_status = 'En camino'
        FOR UPDATE OF order_data
      `, [Number(req.params.id), req.user.id]);
      if (!completionOrder.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'El pedido no está listo para finalizar' });
      }
      const destinationIsExact = completionOrder.rows[0].delivery_latitude != null
        && completionOrder.rows[0].delivery_longitude != null;
      if (destinationIsExact) {
        const profileResult = await client.query(`
          SELECT current_latitude, current_longitude, current_accuracy, last_location_at
          FROM pedidos_app_delivery_profiles
          WHERE user_id = $1
          FOR UPDATE
        `, [req.user.id]);
        const profile = profileResult.rows[0] || {};
        const arrival = buildArrivalStatus({
          destinationLatitude: completionOrder.rows[0].delivery_latitude,
          destinationLongitude: completionOrder.rows[0].delivery_longitude,
          latitude: profile.current_latitude,
          longitude: profile.current_longitude,
          accuracy: profile.current_accuracy,
          locationAt: profile.last_location_at,
          acceptedAt: completionOrder.rows[0].delivery_accepted_at,
          radiusMeters: completionOrder.rows[0].delivery_completion_radius_meters,
        });
        if (!arrival.hasCurrentLocation) {
          await client.query('ROLLBACK');
          return res.status(409).json({ code: 'GPS_LOCATION_REQUIRED', error: 'Activa el GPS para validar que llegaste al destino.', arrival });
        }
        if (!arrival.isFresh) {
          await client.query('ROLLBACK');
          return res.status(409).json({ code: 'GPS_LOCATION_STALE', error: 'Estamos actualizando tu ubicación. Espera unos segundos e inténtalo de nuevo.', arrival });
        }
        if (!arrival.isAccuracyAcceptable) {
          await client.query('ROLLBACK');
          return res.status(409).json({ code: 'GPS_ACCURACY_LOW', error: 'La señal GPS aún no es suficientemente precisa. Muévete a un lugar abierto e inténtalo de nuevo.', arrival });
        }
        if (!arrival.isWithinRange) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            code: 'OUTSIDE_DELIVERY_GEOFENCE',
            error: `Aún estás a ${arrival.distanceMeters} m del destino. Acércate a ${arrival.radiusMeters} m para finalizar.`,
            arrival,
          });
        }
      }
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_status = 'Entregado', status = 'Entregado',
            delivery_completed_at = NOW(), delivered_at = COALESCE(delivered_at, NOW()),
            completed_at = COALESCE(completed_at, NOW()), delivery_notes = $1,
            delivery_rating = $2, delivery_evidence = $3,
            delivery_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - created_at))::integer),
            updated_at = NOW()
        WHERE id = $4 AND delivery_user_id = $5 AND delivery_status = 'En camino'
        RETURNING *
      `, [String(req.body.notes || '').slice(0, 2000), rating, evidence, Number(req.params.id), req.user.id]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'El pedido no está listo para finalizar' });
      }
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET availability_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM pedidos_app_orders active_order
                WHERE active_order.delivery_user_id = $2
                  AND active_order.delivery_status = ANY($3::text[])
              ) THEN 'Ocupado' ELSE 'Libre' END,
            rating_sum = rating_sum + COALESCE($1, 0),
            rating_count = rating_count + CASE WHEN $1 IS NULL THEN 0 ELSE 1 END,
            updated_at = NOW()
        WHERE user_id = $2
      `, [rating, req.user.id, CARRYING_DELIVERY_STATUSES]);
      await client.query('COMMIT');
      realtime.publish('order_updated', { orderId: rows[0].id, deliveryStatus: 'Entregado', orderStatus: 'Entregado' });
      res.json({ status: 'ok', order: formatOrder(rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error finalizando entrega:', error);
      res.status(500).json({ error: 'No fue posible finalizar la entrega' });
    } finally {
      client.release();
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
               COALESCE(SUM(delivery_fee), 0)::numeric AS income,
               COALESCE(SUM(delivery_distance_km), 0)::numeric AS kilometers,
               COALESCE(AVG(delivery_duration_seconds), 0)::numeric AS average_seconds,
               COALESCE(AVG(delivery_rating), 0)::numeric AS average_rating
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
        deliveries: Number(data.deliveries), income: Number(data.income), kilometers: Number(data.kilometers),
        averageSeconds: Number(data.average_seconds), averageRating: Number(data.average_rating),
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
               profile.last_location_at, profile.connected_at,
               CASE
                 WHEN profile.last_location_at IS NOT NULL AND profile.last_location_at >= NOW() - INTERVAL '2 minutes'
                   THEN profile.availability_status
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
                 WHERE o.delivery_user_id = u.id AND o.delivery_status IN ('Aceptado', 'Recogido', 'En camino')
               ) AS active_orders
        FROM pedidos_app_users u
        JOIN pedidos_app_roles role ON role.id = u.role_id AND role.name = 'Domiciliario'
        LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT id, delivery_status, customer_name, address, delivery_latitude, delivery_longitude,
                 COUNT(*) OVER ()::int AS active_order_count
          FROM pedidos_app_orders
          WHERE delivery_user_id = u.id AND delivery_status IN ('Aceptado', 'Recogido', 'En camino')
          ORDER BY created_at ASC LIMIT 1
        ) active_order ON TRUE
        WHERE u.status = 'Activo'
        ORDER BY live_status, name
      `),
      pool.query(`${orderSelect}
        WHERE lower(order_data.delivery_type) = 'domicilio'
          AND order_data.status = 'Listo'
          AND order_data.delivery_status = 'Pendiente'
        ORDER BY order_data.created_at ASC
      `),
      pool.query(`
        SELECT restaurant_name, COALESCE(kitchen_address, address) AS address,
               store_latitude, store_longitude
        FROM pedidos_app_settings
        WHERE id = 1
      `),
    ]);
    const online = realtime.onlineUserIds();
    const liveDrivers = drivers.rows.map((driver) => ({
      ...driver,
      live_status: online.has(Number(driver.id))
        ? (driver.active_order_id ? 'Ocupado' : 'Libre')
        : driver.live_status,
    }));
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
    const userId = req.body.userId == null || req.body.userId === '' ? null : Number(req.body.userId);
    if (!Number.isInteger(orderId) || (userId !== null && !Number.isInteger(userId))) return res.status(400).json({ error: 'Asignación inválida' });
    if (userId !== null) {
      const driver = await pool.query(`
        SELECT u.id FROM pedidos_app_users u
        JOIN pedidos_app_roles role ON role.id = u.role_id
        WHERE u.id = $1 AND u.status = 'Activo' AND role.name = 'Domiciliario'
      `, [userId]);
      if (!driver.rowCount) return res.status(400).json({ error: 'El usuario seleccionado no es un domiciliario activo' });
    }
    const { rows: previousRows } = await pool.query('SELECT delivery_user_id FROM pedidos_app_orders WHERE id = $1', [orderId]);
    const previousUserId = previousRows[0]?.delivery_user_id || null;
    const { rows } = await pool.query(`
      UPDATE pedidos_app_orders
      SET delivery_user_id = $1, delivery_status = 'Pendiente',
          delivery_accepted_at = NULL, updated_at = NOW()
      WHERE id = $2 AND lower(delivery_type) = 'domicilio'
        AND delivery_status NOT IN ('En camino', 'Entregado', 'Cancelado')
      RETURNING *
    `, [userId, orderId]);
    if (!rows.length) return res.status(409).json({ error: 'Este pedido no puede reasignarse en su estado actual' });
    realtime.publish('order_available', { orderId, deliveryUserId: userId });
    if (userId) {
      sendPush({ userId, title: 'Nuevo pedido asignado', body: `Tienes asignado el pedido #${orderId}`, url: `/pedidos/${orderId}` })
        .catch((error) => console.error('Error enviando push de asignación:', error));
    }
    if (previousUserId && Number(previousUserId) !== Number(userId)) {
      sendPush({ userId: previousUserId, title: 'Pedido reasignado', body: `El pedido #${orderId} ya no está asignado a tu usuario`, url: '/' })
        .catch((error) => console.error('Error enviando push de reasignación:', error));
    }
    res.json({ status: 'ok', order: formatOrder(rows[0]) });
  });

  return {
    publish: realtime.publish,
    sendPush,
  };
};
