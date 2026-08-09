const DEFAULT_COMPLETION_RADIUS_METERS = 150;
const DEFAULT_MAX_GPS_ACCURACY_METERS = 200;
const DEFAULT_MAX_GPS_AGE_SECONDS = 180;

function haversineKilometers(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latDistance = radians(toLatitude - fromLatitude);
  const lonDistance = radians(toLongitude - fromLongitude);
  const value = Math.sin(latDistance / 2) ** 2
    + Math.cos(radians(fromLatitude)) * Math.cos(radians(toLatitude)) * Math.sin(lonDistance / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function buildArrivalStatus({
  destinationLatitude,
  destinationLongitude,
  latitude,
  longitude,
  accuracy,
  locationAt,
  startedAt,
  radiusMeters,
  maxGpsAgeSeconds,
  maxGpsAccuracyMeters,
  now = Date.now(),
}) {
  const radius = boundedInteger(radiusMeters, DEFAULT_COMPLETION_RADIUS_METERS, 50, 500);
  const maxAge = boundedInteger(maxGpsAgeSeconds, DEFAULT_MAX_GPS_AGE_SECONDS, 30, 900) * 1000;
  const maxAccuracy = boundedInteger(maxGpsAccuracyMeters, DEFAULT_MAX_GPS_ACCURACY_METERS, 20, 1000);
  const hasExactDestination = destinationLatitude != null && destinationLongitude != null;
  const hasCurrentLocation = latitude != null && longitude != null
    && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
  const numericAccuracy = accuracy == null ? null : Number(accuracy);

  if (!hasExactDestination) {
    return {
      required: false,
      hasExactDestination: false,
      distanceMeters: null,
      radiusMeters: radius,
      hasCurrentLocation,
      isFresh: false,
      accuracyMeters: Number.isFinite(numericAccuracy) ? Math.round(numericAccuracy) : null,
      isAccuracyAcceptable: true,
      isWithinRange: true,
    };
  }

  const locationTime = locationAt ? new Date(locationAt).getTime() : NaN;
  const startedTime = startedAt ? new Date(startedAt).getTime() : NaN;
  const isFresh = hasCurrentLocation
    && Number.isFinite(locationTime)
    && now - locationTime <= maxAge
    && now >= locationTime - 60_000
    && (!Number.isFinite(startedTime) || locationTime >= startedTime);
  const isAccuracyAcceptable = numericAccuracy == null
    || (Number.isFinite(numericAccuracy) && numericAccuracy <= maxAccuracy);
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
    accuracyMeters: Number.isFinite(numericAccuracy) ? Math.round(numericAccuracy) : null,
    isAccuracyAcceptable,
    isWithinRange: isFresh && isAccuracyAcceptable && distanceMeters != null && distanceMeters <= radius,
  };
}

module.exports = {
  DEFAULT_COMPLETION_RADIUS_METERS,
  DEFAULT_MAX_GPS_ACCURACY_METERS,
  DEFAULT_MAX_GPS_AGE_SECONDS,
  buildArrivalStatus,
  haversineKilometers,
};
