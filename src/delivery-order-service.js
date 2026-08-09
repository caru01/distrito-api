const crypto = require('crypto');
const {
  COMMITTED_DELIVERY_STATUSES,
  assertOwnDeliveryTransition,
  domainError,
} = require('./delivery-domain');
const { buildArrivalStatus } = require('./delivery-geo');

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function operationKey(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 120) : `compat-${crypto.randomUUID()}`;
}

function safeDeviceId(value) {
  const normalized = String(value || '').trim().slice(0, 100);
  if (!normalized) throw domainError('DEVICE_ID_REQUIRED', 'Este dispositivo no tiene una identificación operativa válida.', 400);
  return normalized;
}

function parseEvidence(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl));
  if (!match) throw domainError('INVALID_EVIDENCE_FILE', 'La evidencia debe ser una fotografía JPEG, PNG o WebP.', 400);
  const contents = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!contents.length || contents.length > 2 * 1024 * 1024) {
    throw domainError('EVIDENCE_FILE_TOO_LARGE', 'La fotografía supera el límite de 2 MB.', 413);
  }
  const mimeType = match[1].toLowerCase();
  const isJpeg = contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff;
  const isPng = contents.length >= 8 && contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = contents.length >= 12
    && contents.subarray(0, 4).toString('ascii') === 'RIFF'
    && contents.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((mimeType === 'image/jpeg' && !isJpeg)
      || (mimeType === 'image/png' && !isPng)
      || (mimeType === 'image/webp' && !isWebp)) {
    throw domainError('INVALID_EVIDENCE_FILE', 'El contenido de la fotografía no coincide con su formato.', 400);
  }
  return {
    contents,
    mimeType,
    byteSize: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
  };
}

class DeliveryOrderService {
  constructor({ pool, releaseProductStock = null }) {
    this.pool = pool;
    this.releaseProductStock = releaseProductStock;
  }

  async appendDomainEvent(client, eventType, aggregateType, aggregateId, payload = {}) {
    const eventId = crypto.randomUUID();
    const { rows } = await client.query(`
      INSERT INTO pedidos_app_domain_events
        (event_id, aggregate_type, aggregate_id, event_type, payload)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      RETURNING id, event_id
    `, [eventId, aggregateType, String(aggregateId), eventType, JSON.stringify({ ...payload, eventId })]);
    return rows[0];
  }

  async audit(client, { actor, module = 'Domicilios', action, details, requestData = {} }) {
    await client.query(`
      INSERT INTO pedidos_app_audit_logs
        (user_id, username_attempted, module, action, details, request_data)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [actor?.id || null, actor?.username || null, module, action, details, JSON.stringify(requestData)]);
  }

  async withOperation({ operation, key, actorId, orderId = null, request = {} }, handler) {
    const client = await this.pool.connect();
    const idempotencyKey = operationKey(key);
    const requestFingerprint = fingerprint({ operation, actorId, orderId, request });
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`
        INSERT INTO pedidos_app_delivery_idempotency
          (operation, idempotency_key, actor_user_id, order_id, request_fingerprint)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (operation, actor_user_id, idempotency_key) DO NOTHING
        RETURNING id
      `, [operation, idempotencyKey, actorId, orderId, requestFingerprint]);
      if (!inserted.rowCount) {
        const existing = await client.query(`
          SELECT order_id, request_fingerprint, response_status, response_body, completed_at
          FROM pedidos_app_delivery_idempotency
          WHERE operation=$1 AND actor_user_id=$2 AND idempotency_key=$3
          FOR UPDATE
        `, [operation, actorId, idempotencyKey]);
        const record = existing.rows[0];
        if (!record || record.request_fingerprint !== requestFingerprint || Number(record.order_id || 0) !== Number(orderId || 0)) {
          throw domainError('IDEMPOTENCY_KEY_REUSED', 'El identificador de operación ya fue utilizado con otros datos.', 409);
        }
        if (!record.completed_at || !record.response_body) {
          throw domainError('OPERATION_IN_PROGRESS', 'La operación todavía está siendo procesada.', 409);
        }
        await client.query('COMMIT');
        return { ...record.response_body, replayed: true };
      }

      const result = await handler(client);
      const response = { ...result, replayed: false };
      await client.query(`
        UPDATE pedidos_app_delivery_idempotency
        SET response_status=200, response_body=$1::jsonb, completed_at=NOW()
        WHERE id=$2
      `, [JSON.stringify(result), inserted.rows[0].id]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureProfile(client, userId) {
    await client.query(`
      INSERT INTO pedidos_app_delivery_profiles (user_id, availability_status)
      VALUES ($1, 'Desconectado')
      ON CONFLICT (user_id) DO NOTHING
    `, [userId]);
  }

  async lockProfile(client, userId) {
    await this.ensureProfile(client, userId);
    const { rows } = await client.query(`
      SELECT profile.*, settings.presence_timeout_seconds,
             settings.delivery_completion_radius_meters,
             settings.gps_max_age_seconds, settings.gps_max_accuracy_meters
      FROM pedidos_app_delivery_profiles profile
      LEFT JOIN pedidos_app_settings settings ON settings.id=1
      WHERE profile.user_id=$1
      FOR UPDATE OF profile
    `, [userId]);
    return rows[0];
  }

  assertOperationalProfile(profile, deviceId, { requireFreshPresence = false } = {}) {
    if (!profile?.shift_active) throw domainError('SHIFT_NOT_ACTIVE', 'Inicia tu turno antes de realizar esta operación.', 409);
    if (profile.tracking_device_id && profile.tracking_device_id !== deviceId) {
      throw domainError('TRACKING_ACTIVE_ON_ANOTHER_DEVICE', 'El GPS oficial del turno está activo en otro dispositivo.', 409, {
        trackingDeviceId: profile.tracking_device_id,
      });
    }
    if (requireFreshPresence) {
      const lastSeen = profile.last_seen_at ? new Date(profile.last_seen_at).getTime() : 0;
      const timeoutMs = Number(profile.presence_timeout_seconds || 90) * 1000;
      if (!lastSeen || Date.now() - lastSeen > timeoutMs) {
        throw domainError('DRIVER_NOT_ONLINE', 'El domiciliario no tiene un heartbeat reciente.', 409);
      }
    }
  }

  async committedCount(client, userId) {
    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM pedidos_app_orders
      WHERE delivery_user_id=$1
        AND COALESCE(delivery_provider_type, 'own')='own'
        AND delivery_status=ANY($2::text[])
    `, [userId, COMMITTED_DELIVERY_STATUSES]);
    return Number(rows[0]?.count || 0);
  }

  async recomputeDriver(client, userId) {
    if (!userId) return;
    await client.query(`
      UPDATE pedidos_app_delivery_profiles profile
      SET availability_status = CASE
            WHEN NOT profile.shift_active THEN 'Desconectado'
            WHEN EXISTS (
              SELECT 1 FROM pedidos_app_orders order_data
              WHERE order_data.delivery_user_id=profile.user_id
                AND COALESCE(order_data.delivery_provider_type, 'own')='own'
                AND order_data.delivery_status=ANY($2::text[])
            ) THEN 'Ocupado' ELSE 'Libre' END,
          tracking_mode = CASE
            WHEN NOT profile.shift_active THEN 'OFF'
            WHEN EXISTS (
              SELECT 1 FROM pedidos_app_orders order_data
              WHERE order_data.delivery_user_id=profile.user_id
                AND order_data.delivery_status IN ('Recogido','En camino')
            ) THEN 'DELIVERY' ELSE 'FREE' END,
          updated_at=NOW()
      WHERE profile.user_id=$1
    `, [userId, COMMITTED_DELIVERY_STATUSES]);
  }

  async startShift({ driverId, actor, deviceId, idempotencyKey, transfer = false }) {
    const operationalDevice = safeDeviceId(deviceId);
    return this.withOperation({
      operation: 'startShift', key: idempotencyKey, actorId: actor.id,
      request: { driverId, operationalDevice, transfer: Boolean(transfer) },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      if (profile.shift_active && profile.tracking_device_id
          && profile.tracking_device_id !== operationalDevice && !transfer) {
        throw domainError('TRACKING_ACTIVE_ON_ANOTHER_DEVICE', 'Otro dispositivo mantiene el GPS oficial del turno.', 409);
      }
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET shift_active=TRUE,
            shift_started_at=CASE WHEN shift_active THEN shift_started_at ELSE NOW() END,
            shift_ended_at=NULL, tracking_device_id=$1, tracking_lease_at=NOW(),
            last_seen_at=NOW(), connected_at=NOW(), gps_status='active',
            tracking_mode=CASE WHEN EXISTS (
              SELECT 1 FROM pedidos_app_orders
              WHERE delivery_user_id=$2 AND delivery_status IN ('Recogido','En camino')
            ) THEN 'DELIVERY' ELSE 'FREE' END,
            availability_status=CASE WHEN EXISTS (
              SELECT 1 FROM pedidos_app_orders
              WHERE delivery_user_id=$2 AND COALESCE(delivery_provider_type,'own')='own'
                AND delivery_status=ANY($3::text[])
            ) THEN 'Ocupado' ELSE 'Libre' END,
            updated_at=NOW()
        WHERE user_id=$2
      `, [operationalDevice, driverId, COMMITTED_DELIVERY_STATUSES]);
      await this.audit(client, {
        actor, action: profile.shift_active ? 'Reanudar turno' : 'Iniciar turno',
        details: `Turno del domiciliario #${driverId} activo`,
        requestData: { driverId, deviceId: operationalDevice, transfer: Boolean(transfer) },
      });
      const event = await this.appendDomainEvent(client, 'driver_shift_started', 'driver', driverId, {
        driverId, deviceId: operationalDevice, transferred: Boolean(profile.tracking_device_id && profile.tracking_device_id !== operationalDevice),
      });
      return { status: 'ok', shift: { active: true, trackingDeviceId: operationalDevice, mode: 'FREE' }, events: [event] };
    });
  }

  async heartbeat({ driverId, deviceId, gpsStatus = 'active' }) {
    const operationalDevice = safeDeviceId(deviceId);
    const allowedGpsStatuses = new Set(['unknown', 'active', 'disabled', 'denied', 'unavailable']);
    const safeGpsStatus = allowedGpsStatuses.has(gpsStatus) ? gpsStatus : 'unknown';
    const { rows } = await this.pool.query(`
      UPDATE pedidos_app_delivery_profiles
      SET last_seen_at=NOW(), connected_at=NOW(), gps_status=$1,
          tracking_lease_at=CASE WHEN tracking_device_id=$2 THEN NOW() ELSE tracking_lease_at END,
          updated_at=NOW()
      WHERE user_id=$3 AND shift_active=TRUE
        AND (tracking_device_id IS NULL OR tracking_device_id=$2)
      RETURNING shift_active, tracking_mode, tracking_device_id, last_seen_at
    `, [safeGpsStatus, operationalDevice, driverId]);
    if (!rows.length) throw domainError('TRACKING_ACTIVE_ON_ANOTHER_DEVICE', 'Este dispositivo no controla el turno activo.', 409);
    return rows[0];
  }

  async endShift({ driverId, actor, deviceId, idempotencyKey, forced = false, reason = '' }) {
    const operationalDevice = safeDeviceId(deviceId);
    return this.withOperation({
      operation: 'endShift', key: idempotencyKey, actorId: actor.id,
      request: { driverId, operationalDevice, forced: Boolean(forced), reason: String(reason || '') },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      if (!profile.shift_active) return { status: 'ok', shift: { active: false, mode: 'OFF' }, events: [] };
      if (!forced && profile.tracking_device_id && profile.tracking_device_id !== operationalDevice) {
        throw domainError('TRACKING_ACTIVE_ON_ANOTHER_DEVICE', 'Finaliza el turno desde el dispositivo GPS oficial.', 409);
      }
      const committed = await this.committedCount(client, driverId);
      if (committed > 0 && !forced) {
        throw domainError('SHIFT_HAS_COMMITTED_ORDERS', `No puedes finalizar el turno con ${committed} pedido(s) comprometido(s).`, 409, { committed });
      }
      if (forced && String(reason || '').trim().length < 10) {
        throw domainError('SHIFT_OVERRIDE_REASON_REQUIRED', 'Indica un motivo de al menos 10 caracteres.', 400);
      }
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET shift_active=FALSE, shift_ended_at=NOW(), tracking_device_id=NULL,
            tracking_lease_at=NULL, tracking_mode='OFF', availability_status='Desconectado',
            gps_status='unknown', updated_at=NOW()
        WHERE user_id=$1
      `, [driverId]);
      await this.audit(client, {
        actor, action: forced ? 'Forzar fin de turno' : 'Finalizar turno',
        details: `Turno del domiciliario #${driverId} finalizado`,
        requestData: { driverId, deviceId: operationalDevice, forced: Boolean(forced), reason: String(reason || '') },
      });
      const event = await this.appendDomainEvent(client, 'driver_shift_ended', 'driver', driverId, {
        driverId, deviceId: operationalDevice, forced: Boolean(forced), reason: String(reason || ''),
      });
      return { status: 'ok', shift: { active: false, mode: 'OFF' }, events: [event] };
    });
  }

  async transferTrackingDevice({ driverId, actor, deviceId, idempotencyKey }) {
    const operationalDevice = safeDeviceId(deviceId);
    return this.withOperation({
      operation: 'transferTrackingDevice', key: idempotencyKey, actorId: actor.id,
      request: { driverId, operationalDevice },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      if (!profile.shift_active) throw domainError('SHIFT_NOT_ACTIVE', 'No existe un turno activo para transferir.', 409);
      const previousDeviceId = profile.tracking_device_id;
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET tracking_device_id=$1, tracking_lease_at=NOW(), last_seen_at=NOW(), updated_at=NOW()
        WHERE user_id=$2
      `, [operationalDevice, driverId]);
      await this.audit(client, {
        actor, action: 'Transferir dispositivo GPS', details: `GPS del domiciliario #${driverId} transferido`,
        requestData: { driverId, previousDeviceId, deviceId: operationalDevice },
      });
      const event = await this.appendDomainEvent(client, 'driver_tracking_transferred', 'driver', driverId, {
        driverId, previousDeviceId, deviceId: operationalDevice,
      });
      return { status: 'ok', trackingDeviceId: operationalDevice, events: [event] };
    });
  }

  async acceptOrder({ orderId, driverId, actor, deviceId, idempotencyKey }) {
    const operationalDevice = safeDeviceId(deviceId);
    return this.withOperation({
      operation: 'acceptOrder', key: idempotencyKey, actorId: actor.id, orderId,
      request: { driverId, operationalDevice },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      this.assertOperationalProfile(profile, operationalDevice);
      const orderResult = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order || String(order.delivery_type || '').toLowerCase() !== 'domicilio') {
        throw domainError('ORDER_NOT_FOUND', 'Pedido de domicilio no encontrado.', 404);
      }
      if (String(order.delivery_provider_type || '').startsWith('external_')) {
        throw domainError('ORDER_ASSIGNED_EXTERNAL', 'El pedido pertenece a un operador logístico externo.', 409);
      }
      if (order.status !== 'Listo' || order.delivery_status !== 'Pendiente'
          || (order.delivery_user_id && Number(order.delivery_user_id) !== Number(driverId))) {
        throw domainError('ORDER_ALREADY_TAKEN', 'Otro domiciliario tomó el pedido o ya no está disponible.', 409);
      }
      assertOwnDeliveryTransition(order.delivery_status, 'Aceptado');
      const committed = await this.committedCount(client, driverId);
      const addsCommitment = Number(order.delivery_user_id || 0) !== Number(driverId);
      const capacity = Number(profile.max_active_orders || 1);
      if (committed + (addsCommitment ? 1 : 0) > capacity) {
        throw domainError('DRIVER_AT_CAPACITY', `Alcanzaste tu capacidad de ${capacity} pedido(s).`, 409, { capacity, committed });
      }
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_user_id=$1, delivery_provider_type='own', delivery_status='Aceptado',
            status='Listo', delivery_accepted_at=COALESCE(delivery_accepted_at,NOW()),
            accepted_by_device_id=$2, version=version+1, updated_at=NOW()
        WHERE id=$3 AND status='Listo' AND delivery_status='Pendiente'
          AND (delivery_user_id IS NULL OR delivery_user_id=$1)
        RETURNING *
      `, [driverId, operationalDevice, orderId]);
      if (!rows.length) throw domainError('ORDER_ALREADY_TAKEN', 'Otro domiciliario tomó el pedido.', 409);
      await client.query(`
        INSERT INTO pedidos_app_delivery_events
          (order_id,event_type,provider_type,delivery_user_id,actor_user_id,actor_name,notes,metadata)
        VALUES ($1,'accepted_own','own',$2,$2,$3,'Pedido aceptado; pendiente de iniciar entrega',$4::jsonb)
      `, [orderId, driverId, actor.username || null, JSON.stringify({ deviceId: operationalDevice })]);
      await this.recomputeDriver(client, driverId);
      await this.audit(client, {
        actor, action: 'Aceptar pedido', details: `Pedido #${orderId} aceptado`,
        requestData: { orderId, driverId, deviceId: operationalDevice },
      });
      const event = await this.appendDomainEvent(client, 'order_accepted', 'order', orderId, {
        orderId, deliveryUserId: driverId, orderStatus: 'Listo', deliveryStatus: 'Aceptado',
      });
      return { status: 'ok', order: rows[0], events: [event] };
    });
  }

  async startDelivery({ orderId, driverId, actor, deviceId, idempotencyKey }) {
    const operationalDevice = safeDeviceId(deviceId);
    return this.withOperation({
      operation: 'startDelivery', key: idempotencyKey, actorId: actor.id, orderId,
      request: { driverId, operationalDevice },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      this.assertOperationalProfile(profile, operationalDevice);
      const { rows: currentRows } = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const current = currentRows[0];
      if (!current || Number(current.delivery_user_id) !== Number(driverId)) {
        throw domainError('ORDER_NOT_ASSIGNED', 'El pedido no está asignado a este domiciliario.', 409);
      }
      if (!['Aceptado', 'Recogido'].includes(current.delivery_status)) {
        throw domainError('INVALID_ORDER_STATE', 'El pedido debe estar aceptado antes de iniciar la entrega.', 409);
      }
      assertOwnDeliveryTransition(current.delivery_status, 'En camino');
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_status='En camino', status='En camino',
            picked_up_at=COALESCE(picked_up_at,NOW()), on_the_way_at=COALESCE(on_the_way_at,NOW()),
            version=version+1, updated_at=NOW()
        WHERE id=$1 AND delivery_user_id=$2 AND delivery_status IN ('Aceptado','Recogido')
        RETURNING *
      `, [orderId, driverId]);
      await client.query(`
        INSERT INTO pedidos_app_delivery_events
          (order_id,event_type,provider_type,delivery_user_id,actor_user_id,actor_name,notes,metadata)
        VALUES ($1,'delivery_started','own',$2,$2,$3,'Pedido recogido e inicio de entrega',$4::jsonb)
      `, [orderId, driverId, actor.username || null, JSON.stringify({ deviceId: operationalDevice })]);
      await this.recomputeDriver(client, driverId);
      await this.audit(client, {
        actor, action: 'Iniciar entrega', details: `Pedido #${orderId} recogido y en camino`,
        requestData: { orderId, driverId, deviceId: operationalDevice },
      });
      const event = await this.appendDomainEvent(client, 'order_delivery_started', 'order', orderId, {
        orderId, deliveryUserId: driverId, orderStatus: 'En camino', deliveryStatus: 'En camino',
      });
      return { status: 'ok', order: rows[0], events: [event] };
    });
  }

  async reserveOrder({ orderId, driverId, actor, idempotencyKey }) {
    return this.withOperation({
      operation: 'reserveOrder', key: idempotencyKey, actorId: actor.id, orderId,
      request: { driverId },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      this.assertOperationalProfile(profile, profile.tracking_device_id || 'admin-reservation', { requireFreshPresence: true });
      const { rows: currentRows } = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const current = currentRows[0];
      if (!current || current.status !== 'Listo' || current.delivery_status !== 'Pendiente'
          || String(current.delivery_type || '').toLowerCase() !== 'domicilio') {
        throw domainError('ORDER_ALREADY_TAKEN', 'El pedido ya no está disponible para asignación.', 409);
      }
      const committed = await this.committedCount(client, driverId);
      const addsCommitment = Number(current.delivery_user_id || 0) !== Number(driverId);
      const capacity = Number(profile.max_active_orders || 1);
      if (committed + (addsCommitment ? 1 : 0) > capacity) {
        throw domainError('DRIVER_AT_CAPACITY', `El domiciliario alcanzó su capacidad de ${capacity} pedido(s).`, 409, { capacity, committed });
      }
      const previousUserId = current.delivery_user_id;
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_user_id=$1, delivery_provider_type='own', delivery_status='Pendiente',
            external_delivery_company_id=NULL, external_driver_name=NULL, external_driver_phone=NULL,
            external_vehicle_id=NULL, external_delivery_cost=0, external_delivery_notes=NULL,
            external_eta_minutes=NULL, external_provider_reference=NULL, external_assigned_at=NULL,
            external_handed_off_at=NULL, delivery_accepted_at=NULL, accepted_by_device_id=NULL,
            version=version+1, updated_at=NOW()
        WHERE id=$2 AND status='Listo' AND delivery_status='Pendiente'
        RETURNING *
      `, [driverId, orderId]);
      if (!rows.length) throw domainError('ORDER_ALREADY_TAKEN', 'El pedido ya no está disponible para asignación.', 409);
      await client.query(`
        INSERT INTO pedidos_app_delivery_events
          (order_id,event_type,provider_type,delivery_user_id,actor_user_id,actor_name,notes,metadata)
        VALUES ($1,$2,'own',$3,$4,$5,'Reserva de capacidad desde el ERP',$6::jsonb)
      `, [orderId, previousUserId && Number(previousUserId) !== Number(driverId) ? 'reassigned' : 'assigned_own',
        driverId, actor.id, actor.username || null, JSON.stringify({ previousDeliveryUserId: previousUserId || null })]);
      await this.recomputeDriver(client, driverId);
      if (previousUserId && Number(previousUserId) !== Number(driverId)) await this.recomputeDriver(client, previousUserId);
      await this.audit(client, {
        actor, action: 'Reservar pedido', details: `Pedido #${orderId} reservado al domiciliario #${driverId}`,
        requestData: { orderId, driverId, previousUserId: previousUserId || null },
      });
      const event = await this.appendDomainEvent(client, 'order_reserved', 'order', orderId, {
        orderId, deliveryUserId: driverId, previousDeliveryUserId: previousUserId || null,
        orderStatus: 'Listo', deliveryStatus: 'Pendiente',
      });
      return { status: 'ok', order: rows[0], events: [event] };
    });
  }

  async completeDelivery({ orderId, driverId, actor, deviceId, idempotencyKey, completion }) {
    const operationalDevice = safeDeviceId(deviceId);
    if (completion.confirmReceived !== true) {
      throw domainError('DELIVERY_CONFIRMATION_REQUIRED', 'Debes confirmar que el cliente recibió el pedido.', 400);
    }
    const rating = completion.rating === '' || completion.rating == null ? null : Number(completion.rating);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw domainError('INVALID_DELIVERY_RATING', 'La calificación debe estar entre 1 y 5.', 400);
    }
    const evidence = parseEvidence(completion.evidence);
    return this.withOperation({
      operation: 'completeDelivery', key: idempotencyKey, actorId: actor.id, orderId,
      request: {
        driverId, operationalDevice, rating, notes: String(completion.notes || '').slice(0, 2000),
        evidenceSha256: evidence?.sha256 || null, geofenceOverrideId: completion.geofenceOverrideId || null,
      },
    }, async (client) => {
      const profile = await this.lockProfile(client, driverId);
      this.assertOperationalProfile(profile, operationalDevice);
      const { rows: currentRows } = await client.query(`
        SELECT order_data.*, settings.delivery_completion_radius_meters,
               settings.gps_max_age_seconds, settings.gps_max_accuracy_meters
        FROM pedidos_app_orders order_data
        LEFT JOIN pedidos_app_settings settings ON settings.id=1
        WHERE order_data.id=$1
        FOR UPDATE OF order_data
      `, [orderId]);
      const current = currentRows[0];
      if (!current || Number(current.delivery_user_id) !== Number(driverId)) {
        throw domainError('ORDER_NOT_ASSIGNED', 'El pedido no está asignado a este domiciliario.', 409);
      }
      assertOwnDeliveryTransition(current.delivery_status, 'Entregado');
      const destinationIsExact = current.delivery_latitude != null && current.delivery_longitude != null;
      let override = null;
      if (completion.geofenceOverrideId) {
        const overrideResult = await client.query(`
          SELECT * FROM pedidos_app_delivery_geofence_overrides
          WHERE id=$1 AND order_id=$2
        `, [completion.geofenceOverrideId, orderId]);
        override = overrideResult.rows[0] || null;
      }
      if (!destinationIsExact && !override) {
        throw domainError('GEOFENCE_OVERRIDE_REQUIRED', 'Este pedido no tiene coordenadas exactas. Solicita una autorización administrativa para finalizar.', 409);
      }
      const arrival = buildArrivalStatus({
        destinationLatitude: current.delivery_latitude,
        destinationLongitude: current.delivery_longitude,
        latitude: profile.current_latitude,
        longitude: profile.current_longitude,
        accuracy: profile.current_accuracy,
        locationAt: profile.last_location_at,
        startedAt: current.picked_up_at || current.on_the_way_at,
        radiusMeters: current.delivery_completion_radius_meters,
        maxGpsAgeSeconds: current.gps_max_age_seconds,
        maxGpsAccuracyMeters: current.gps_max_accuracy_meters,
      });
      if (destinationIsExact && !override) {
        if (!arrival.hasCurrentLocation) throw domainError('GPS_LOCATION_REQUIRED', 'Activa el GPS para validar la llegada.', 409, { arrival });
        if (!arrival.isFresh) throw domainError('GPS_TOO_OLD', 'La ubicación GPS está desactualizada.', 409, { arrival });
        if (!arrival.isAccuracyAcceptable) throw domainError('GPS_ACCURACY_TOO_LOW', 'La precisión GPS todavía no es suficiente.', 409, { arrival });
        if (!arrival.isWithinRange) throw domainError('GEOFENCE_OUTSIDE_RADIUS', `Aún estás a ${arrival.distanceMeters} m del destino.`, 409, { arrival });
      }
      let evidenceReference = current.delivery_evidence || null;
      if (evidence) {
        const savedEvidence = await client.query(`
          INSERT INTO pedidos_app_delivery_evidence_files
            (order_id, uploaded_by, mime_type, byte_size, sha256, contents)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (order_id) DO UPDATE SET
            uploaded_by=EXCLUDED.uploaded_by, mime_type=EXCLUDED.mime_type,
            byte_size=EXCLUDED.byte_size, sha256=EXCLUDED.sha256,
            contents=EXCLUDED.contents, created_at=NOW()
          RETURNING id
        `, [orderId, driverId, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.contents]);
        evidenceReference = `evidence:${savedEvidence.rows[0].id}`;
      }
      const distance = await client.query(`
        SELECT COALESCE(SUM(distance_from_previous_km),0)::numeric AS kilometers
        FROM pedidos_app_driver_location_points
        WHERE driver_id=$1 AND mode='DELIVERY'
          AND captured_at >= COALESCE($2::timestamptz, captured_at)
          AND captured_at <= NOW()
      `, [driverId, current.picked_up_at || current.on_the_way_at]);
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET delivery_status='Entregado', status='Entregado',
            delivery_completed_at=NOW(), delivered_at=COALESCE(delivered_at,NOW()),
            completed_at=COALESCE(completed_at,NOW()), delivery_notes=$1,
            delivery_rating=$2, delivery_evidence=$3,
            delivery_distance_km=$4,
            delivery_duration_seconds=GREATEST(0,EXTRACT(EPOCH FROM (NOW()-created_at))::integer),
            version=version+1, updated_at=NOW()
        WHERE id=$5 AND delivery_user_id=$6 AND delivery_status='En camino'
        RETURNING *
      `, [String(completion.notes || '').slice(0, 2000), rating, evidenceReference,
        Number(distance.rows[0]?.kilometers || 0), orderId, driverId]);
      if (!rows.length) throw domainError('INVALID_ORDER_STATE', 'El pedido no está listo para finalizar.', 409);
      await client.query(`
        INSERT INTO pedidos_app_delivery_events
          (order_id,event_type,provider_type,delivery_user_id,actor_user_id,actor_name,notes,metadata)
        VALUES ($1,'delivered','own',$2,$2,$3,'Entrega propia finalizada',$4::jsonb)
      `, [orderId, driverId, actor.username || null, JSON.stringify({
        deviceId: operationalDevice, arrival, geofenceOverrideId: override?.id || null,
        evidenceSha256: evidence?.sha256 || null,
      })]);
      await client.query(`
        UPDATE pedidos_app_delivery_profiles
        SET rating_sum=rating_sum+COALESCE($1,0),
            rating_count=rating_count+CASE WHEN $1 IS NULL THEN 0 ELSE 1 END,
            updated_at=NOW()
        WHERE user_id=$2
      `, [rating, driverId]);
      await this.recomputeDriver(client, driverId);
      await this.audit(client, {
        actor, action: 'Finalizar entrega', details: `Pedido #${orderId} entregado`,
        requestData: {
          orderId, driverId, deviceId: operationalDevice, arrival,
          geofenceOverrideId: override?.id || null, evidenceSha256: evidence?.sha256 || null,
        },
      });
      const event = await this.appendDomainEvent(client, 'order_delivered', 'order', orderId, {
        orderId, deliveryUserId: driverId, orderStatus: 'Entregado', deliveryStatus: 'Entregado',
      });
      return { status: 'ok', order: rows[0], arrival, events: [event] };
    });
  }

  async cancelOrder({ orderId, actor, idempotencyKey, reason = '' }) {
    return this.withOperation({
      operation: 'cancelOrder', key: idempotencyKey, actorId: actor.id, orderId,
      request: { reason: String(reason || '') },
    }, async (client) => {
      const snapshot = await client.query('SELECT delivery_user_id FROM pedidos_app_orders WHERE id=$1', [orderId]);
      const driverId = snapshot.rows[0]?.delivery_user_id || null;
      if (driverId) await this.lockProfile(client, driverId);
      const { rows: currentRows } = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const current = currentRows[0];
      if (!current) throw domainError('ORDER_NOT_FOUND', 'Pedido no encontrado.', 404);
      if (['Entregado', 'Completado'].includes(current.status) || current.delivery_status === 'Entregado') {
        throw domainError('INVALID_ORDER_STATE', 'Un pedido entregado no se puede cancelar mediante el flujo normal.', 409);
      }
      if (current.status === 'Cancelado') return { status: 'ok', order: current, events: [] };
      if (this.releaseProductStock) await this.releaseProductStock(client, current, actor.username || 'Sistema');
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders
        SET status='Cancelado', delivery_status='Cancelado', version=version+1, updated_at=NOW()
        WHERE id=$1 RETURNING *
      `, [orderId]);
      if (current.delivery_user_id || current.delivery_provider_type) {
        await client.query(`
          INSERT INTO pedidos_app_delivery_events
            (order_id,event_type,provider_type,delivery_user_id,company_id,actor_user_id,actor_name,external_cost,notes,metadata)
          VALUES ($1,'cancelled',$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        `, [orderId, current.delivery_provider_type || (current.delivery_user_id ? 'own' : null),
          current.delivery_user_id, current.external_delivery_company_id, actor.id, actor.username || null,
          current.external_delivery_cost || null, String(reason || 'Cancelado desde el ERP').slice(0, 2000),
          JSON.stringify({ previousStatus: current.status, previousDeliveryStatus: current.delivery_status })]);
      }
      if (driverId) await this.recomputeDriver(client, driverId);
      await this.audit(client, {
        actor, action: 'Cancelar pedido', details: `Pedido #${orderId} cancelado`,
        requestData: { orderId, reason: String(reason || ''), previousStatus: current.status, previousDeliveryStatus: current.delivery_status },
      });
      const event = await this.appendDomainEvent(client, 'order_cancelled', 'order', orderId, {
        orderId, deliveryUserId: driverId, orderStatus: 'Cancelado', deliveryStatus: 'Cancelado',
      });
      return { status: 'ok', order: rows[0], events: [event] };
    });
  }
}

function createDeliveryOrderService(dependencies) {
  return new DeliveryOrderService(dependencies);
}

module.exports = {
  DeliveryOrderService,
  createDeliveryOrderService,
  operationKey,
  parseEvidence,
  safeDeviceId,
};
