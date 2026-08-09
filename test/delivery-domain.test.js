const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertOwnDeliveryTransition,
  normalizeLegacyDeliveryStatus,
} = require('../src/delivery-domain');
const { buildArrivalStatus, haversineKilometers } = require('../src/delivery-geo');
const { normalizePoint } = require('../src/delivery-location-service');

test('el dominio mantiene la secuencia aceptado, en camino y entregado', () => {
  assert.doesNotThrow(() => assertOwnDeliveryTransition('Pendiente', 'Aceptado'));
  assert.doesNotThrow(() => assertOwnDeliveryTransition('Aceptado', 'En camino'));
  assert.doesNotThrow(() => assertOwnDeliveryTransition('En camino', 'Entregado'));
  assert.throws(() => assertOwnDeliveryTransition('Pendiente', 'Entregado'), (error) => error.code === 'INVALID_ORDER_STATE');
  assert.throws(() => assertOwnDeliveryTransition('Entregado', 'Cancelado'), (error) => error.code === 'INVALID_ORDER_STATE');
  assert.equal(normalizeLegacyDeliveryStatus('Recogido'), 'En camino');
});

test('la geocerca rechaza GPS antiguo o impreciso y acepta una posición vigente', () => {
  const base = {
    destinationLatitude: 10.468235,
    destinationLongitude: -73.253628,
    latitude: 10.46824,
    longitude: -73.25363,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    radiusMeters: 150,
    maxGpsAgeSeconds: 180,
    maxGpsAccuracyMeters: 200,
  };
  assert.equal(buildArrivalStatus({ ...base, accuracy: 12, locationAt: new Date().toISOString() }).isWithinRange, true);
  assert.equal(buildArrivalStatus({ ...base, accuracy: 500, locationAt: new Date().toISOString() }).isWithinRange, false);
  assert.equal(buildArrivalStatus({ ...base, accuracy: 12, locationAt: new Date(Date.now() - 600_000).toISOString() }).isWithinRange, false);
  assert.ok(haversineKilometers(base.latitude, base.longitude, base.destinationLatitude, base.destinationLongitude) * 1000 < 150);
  const withoutGps = buildArrivalStatus({ ...base, latitude: null, longitude: null, locationAt: null });
  assert.equal(withoutGps.hasCurrentLocation, false);
  assert.equal(withoutGps.isWithinRange, false);
  const legacyDestination = buildArrivalStatus({ ...base, destinationLatitude: null, destinationLongitude: null });
  assert.equal(legacyDestination.required, false);
  const boundaryLatitude = base.destinationLatitude + 0.001;
  const boundaryMeters = Math.round(haversineKilometers(boundaryLatitude, base.longitude, base.destinationLatitude, base.destinationLongitude) * 1000);
  const boundary = buildArrivalStatus({
    ...base, latitude: boundaryLatitude, longitude: base.longitude,
    accuracy: 10, locationAt: new Date().toISOString(), radiusMeters: boundaryMeters,
  });
  assert.equal(boundary.distanceMeters, boundaryMeters);
  assert.equal(boundary.isWithinRange, true);
});

test('la normalización GPS rechaza coordenadas, precisión y fechas inválidas', () => {
  const valid = normalizePoint({ id: 'gps-1', latitude: 10.46, longitude: -73.25, accuracy: 20, capturedAt: new Date().toISOString() }, 0);
  assert.equal(valid.clientPointId, 'gps-1');
  assert.throws(() => normalizePoint({ latitude: 91, longitude: -73 }, 0), (error) => error.code === 'INVALID_GPS_COORDINATES');
  assert.throws(() => normalizePoint({ latitude: 10, longitude: -181 }, 0), (error) => error.code === 'INVALID_GPS_COORDINATES');
  assert.throws(() => normalizePoint({ latitude: 10, longitude: -73, accuracy: 6000 }, 0), (error) => error.code === 'INVALID_GPS_ACCURACY');
  assert.throws(() => normalizePoint({ latitude: 10, longitude: -73, capturedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, 0), (error) => error.code === 'GPS_TIMESTAMP_OUT_OF_RANGE');
});
