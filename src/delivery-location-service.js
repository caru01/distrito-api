const crypto = require('crypto');
const { buildArrivalStatus, haversineKilometers } = require('./delivery-geo');
const { domainError } = require('./delivery-domain');
const { safeDeviceId } = require('./delivery-order-service');

const MAX_BATCH_SIZE = 250;
const MAX_OFFLINE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function normalizePoint(point, index) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  const accuracy = point?.accuracy == null ? null : Number(point.accuracy);
  const capturedAt = new Date(point?.capturedAt || point?.captured_at || Date.now());
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw domainError('INVALID_GPS_COORDINATES', `La posición ${index + 1} tiene coordenadas inválidas.`, 400);
  }
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 5000)) {
    throw domainError('INVALID_GPS_ACCURACY', `La posición ${index + 1} tiene una precisión inválida.`, 400);
  }
  if (!Number.isFinite(capturedAt.getTime())) {
    throw domainError('INVALID_GPS_TIMESTAMP', `La posición ${index + 1} no tiene una fecha válida.`, 400);
  }
  const age = Date.now() - capturedAt.getTime();
  if (age > MAX_OFFLINE_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
    throw domainError('GPS_TIMESTAMP_OUT_OF_RANGE', `La posición ${index + 1} está fuera del rango temporal permitido.`, 400);
  }
  const clientPointId = String(point?.id || point?.clientPointId || point?.client_point_id || '').trim().slice(0, 120)
    || crypto.createHash('sha256').update(`${capturedAt.toISOString()}:${latitude}:${longitude}`).digest('hex');
  return {
    clientPointId,
    latitude,
    longitude,
    accuracy,
    speed: point?.speed == null ? null : Number(point.speed),
    bearing: point?.bearing ?? point?.heading ?? null,
    altitude: point?.altitude ?? null,
    provider: String(point?.provider || '').slice(0, 30) || null,
    capturedAt,
  };
}

class DeliveryLocationService {
  constructor({ pool }) {
    this.pool = pool;
  }

  async ingestBatch({ driverId, deviceId, points }) {
    const operationalDevice = safeDeviceId(deviceId);
    if (!Array.isArray(points) || !points.length || points.length > MAX_BATCH_SIZE) {
      throw domainError('INVALID_GPS_BATCH', `Envía entre 1 y ${MAX_BATCH_SIZE} posiciones por lote.`, 400);
    }
    const normalized = points.map(normalizePoint).sort((a, b) => a.capturedAt - b.capturedAt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const profileResult = await client.query(`
        SELECT profile.*, settings.gps_max_accuracy_meters, settings.gps_max_age_seconds,
               settings.delivery_completion_radius_meters
        FROM pedidos_app_delivery_profiles profile
        LEFT JOIN pedidos_app_settings settings ON settings.id=1
        WHERE profile.user_id=$1
        FOR UPDATE OF profile
      `, [driverId]);
      const profile = profileResult.rows[0];
      if (!profile?.shift_active) throw domainError('SHIFT_NOT_ACTIVE', 'El turno no está activo.', 409);
      if (!profile.tracking_device_id || profile.tracking_device_id !== operationalDevice) {
        throw domainError('TRACKING_ACTIVE_ON_ANOTHER_DEVICE', 'Este dispositivo no es el emisor GPS oficial.', 409);
      }
      const activeOrders = await client.query(`
        SELECT id, delivery_latitude, delivery_longitude, picked_up_at, on_the_way_at
        FROM pedidos_app_orders
        WHERE delivery_user_id=$1 AND delivery_status IN ('Recogido','En camino')
        ORDER BY created_at
      `, [driverId]);
      const effectiveMode = activeOrders.rowCount ? 'DELIVERY' : 'FREE';
      const previousResult = await client.query(`
        SELECT latitude, longitude, accuracy, captured_at
        FROM pedidos_app_driver_location_points
        WHERE driver_id=$1 AND device_id=$2
        ORDER BY captured_at DESC LIMIT 1
      `, [driverId, operationalDevice]);
      let previous = previousResult.rows[0] || null;
      let accepted = 0;
      let duplicated = 0;
      let distanceAddedKm = 0;
      let latestAccepted = null;

      for (const point of normalized) {
        let segmentKm = 0;
        if (previous && point.capturedAt.getTime() > new Date(previous.captured_at).getTime()
            && (point.accuracy == null || point.accuracy <= Number(profile.gps_max_accuracy_meters || 200))) {
          const elapsedHours = (point.capturedAt.getTime() - new Date(previous.captured_at).getTime()) / 3_600_000;
          const candidate = haversineKilometers(
            Number(previous.latitude), Number(previous.longitude), point.latitude, point.longitude,
          );
          const impliedSpeed = elapsedHours > 0 ? candidate / elapsedHours : Infinity;
          if (Number.isFinite(candidate) && candidate <= 3 && impliedSpeed <= 180) segmentKm = candidate;
        }
        const inserted = await client.query(`
          INSERT INTO pedidos_app_driver_location_points
            (client_point_id,driver_id,device_id,latitude,longitude,accuracy,speed,bearing,
             altitude,provider,mode,captured_at,distance_from_previous_km)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (driver_id,device_id,client_point_id) DO NOTHING
          RETURNING id
        `, [point.clientPointId, driverId, operationalDevice, point.latitude, point.longitude,
          point.accuracy, Number.isFinite(point.speed) ? point.speed : null,
          Number.isFinite(Number(point.bearing)) ? Number(point.bearing) : null,
          Number.isFinite(Number(point.altitude)) ? Number(point.altitude) : null,
          point.provider, effectiveMode, point.capturedAt, segmentKm]);
        if (!inserted.rowCount) {
          duplicated += 1;
          continue;
        }
        accepted += 1;
        distanceAddedKm += segmentKm;
        latestAccepted = point;
        previous = {
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy: point.accuracy,
          captured_at: point.capturedAt,
        };
      }

      if (latestAccepted) {
        await client.query(`
          UPDATE pedidos_app_delivery_profiles
          SET current_latitude=CASE WHEN last_location_at IS NULL OR last_location_at <= $1 THEN $2 ELSE current_latitude END,
              current_longitude=CASE WHEN last_location_at IS NULL OR last_location_at <= $1 THEN $3 ELSE current_longitude END,
              current_accuracy=CASE WHEN last_location_at IS NULL OR last_location_at <= $1 THEN $4 ELSE current_accuracy END,
              last_location_at=GREATEST(COALESCE(last_location_at,$1),$1),
              last_seen_at=NOW(), connected_at=NOW(), tracking_lease_at=NOW(), gps_status='active',
              tracking_mode=$5::varchar, availability_status=CASE WHEN $5::varchar='DELIVERY' THEN 'Ocupado' ELSE availability_status END,
              updated_at=NOW()
          WHERE user_id=$6
        `, [latestAccepted.capturedAt, latestAccepted.latitude, latestAccepted.longitude,
          latestAccepted.accuracy, effectiveMode, driverId]);
      } else {
        await client.query(`
          UPDATE pedidos_app_delivery_profiles
          SET last_seen_at=NOW(), connected_at=NOW(), tracking_lease_at=NOW(),
              tracking_mode=$1::varchar, updated_at=NOW()
          WHERE user_id=$2
        `, [effectiveMode, driverId]);
      }

      const position = latestAccepted || (profile.current_latitude == null ? null : {
        latitude: Number(profile.current_latitude),
        longitude: Number(profile.current_longitude),
        accuracy: profile.current_accuracy == null ? null : Number(profile.current_accuracy),
        capturedAt: profile.last_location_at,
      });
      const arrivals = {};
      if (position) {
        for (const order of activeOrders.rows) {
          arrivals[order.id] = buildArrivalStatus({
            destinationLatitude: order.delivery_latitude,
            destinationLongitude: order.delivery_longitude,
            latitude: position.latitude,
            longitude: position.longitude,
            accuracy: position.accuracy,
            locationAt: position.capturedAt,
            startedAt: order.picked_up_at || order.on_the_way_at,
            radiusMeters: profile.delivery_completion_radius_meters,
            maxGpsAgeSeconds: profile.gps_max_age_seconds,
            maxGpsAccuracyMeters: profile.gps_max_accuracy_meters,
          });
        }
      }
      await client.query('COMMIT');
      return {
        status: 'ok', accepted, duplicated, mode: effectiveMode, distanceAddedKm,
        position: latestAccepted ? {
          latitude: latestAccepted.latitude,
          longitude: latestAccepted.longitude,
          accuracy: latestAccepted.accuracy,
          capturedAt: latestAccepted.capturedAt.toISOString(),
        } : null,
        orderIds: activeOrders.rows.map((order) => Number(order.id)),
        arrivals,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function createDeliveryLocationService(dependencies) {
  return new DeliveryLocationService(dependencies);
}

module.exports = {
  DeliveryLocationService,
  MAX_BATCH_SIZE,
  createDeliveryLocationService,
  normalizePoint,
};
