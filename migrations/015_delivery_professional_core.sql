-- Núcleo operativo profesional para domiciliarios propios.
-- Preserva pedidos históricos y el flujo independiente de operadores externos.

ALTER TABLE pedidos_app_orders
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS accepted_by_device_id VARCHAR(100);

ALTER TABLE pedidos_app_orders
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_version_check;

ALTER TABLE pedidos_app_orders
  ADD CONSTRAINT pedidos_app_orders_version_check CHECK (version >= 1);

ALTER TABLE pedidos_app_delivery_profiles
  ADD COLUMN IF NOT EXISTS shift_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shift_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shift_ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_device_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tracking_lease_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_mode VARCHAR(20) NOT NULL DEFAULT 'OFF',
  ADD COLUMN IF NOT EXISTS gps_status VARCHAR(30) NOT NULL DEFAULT 'unknown';

ALTER TABLE pedidos_app_delivery_profiles
  DROP CONSTRAINT IF EXISTS delivery_profiles_tracking_mode_check,
  DROP CONSTRAINT IF EXISTS delivery_profiles_gps_status_check,
  ADD CONSTRAINT delivery_profiles_tracking_mode_check
    CHECK (tracking_mode IN ('OFF', 'FREE', 'DELIVERY')),
  ADD CONSTRAINT delivery_profiles_gps_status_check
    CHECK (gps_status IN ('unknown', 'active', 'disabled', 'denied', 'unavailable'));

-- Los perfiles que estaban conectados durante la migración conservan continuidad.
UPDATE pedidos_app_delivery_profiles
SET shift_active = TRUE,
    shift_started_at = COALESCE(shift_started_at, connected_at, NOW()),
    last_seen_at = COALESCE(last_seen_at, connected_at, last_location_at, NOW()),
    tracking_mode = CASE WHEN EXISTS (
      SELECT 1 FROM pedidos_app_orders active_order
      WHERE active_order.delivery_user_id = pedidos_app_delivery_profiles.user_id
        AND active_order.delivery_status IN ('Recogido', 'En camino')
    ) THEN 'DELIVERY' ELSE 'FREE' END
WHERE availability_status <> 'Desconectado';

ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS gps_delivery_interval_seconds SMALLINT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS gps_free_interval_seconds SMALLINT NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS presence_heartbeat_interval_seconds SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS presence_timeout_seconds SMALLINT NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS gps_max_age_seconds SMALLINT NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS gps_max_accuracy_meters SMALLINT NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS offline_location_queue_limit INTEGER NOT NULL DEFAULT 2000;

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_gps_delivery_interval_check,
  DROP CONSTRAINT IF EXISTS settings_gps_free_interval_check,
  DROP CONSTRAINT IF EXISTS settings_presence_heartbeat_check,
  DROP CONSTRAINT IF EXISTS settings_presence_timeout_check,
  DROP CONSTRAINT IF EXISTS settings_gps_max_age_check,
  DROP CONSTRAINT IF EXISTS settings_gps_max_accuracy_check,
  DROP CONSTRAINT IF EXISTS settings_offline_location_queue_check,
  ADD CONSTRAINT settings_gps_delivery_interval_check CHECK (gps_delivery_interval_seconds BETWEEN 3 AND 60),
  ADD CONSTRAINT settings_gps_free_interval_check CHECK (gps_free_interval_seconds BETWEEN 15 AND 300),
  ADD CONSTRAINT settings_presence_heartbeat_check CHECK (presence_heartbeat_interval_seconds BETWEEN 10 AND 120),
  ADD CONSTRAINT settings_presence_timeout_check CHECK (presence_timeout_seconds BETWEEN 30 AND 600),
  ADD CONSTRAINT settings_gps_max_age_check CHECK (gps_max_age_seconds BETWEEN 30 AND 900),
  ADD CONSTRAINT settings_gps_max_accuracy_check CHECK (gps_max_accuracy_meters BETWEEN 20 AND 1000),
  ADD CONSTRAINT settings_offline_location_queue_check CHECK (offline_location_queue_limit BETWEEN 100 AND 20000);

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_idempotency (
  id BIGSERIAL PRIMARY KEY,
  operation VARCHAR(40) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  request_fingerprint VARCHAR(64) NOT NULL,
  response_status SMALLINT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT delivery_idempotency_status_check
    CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  UNIQUE (operation, actor_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS pedidos_app_driver_location_points (
  id BIGSERIAL PRIMARY KEY,
  client_point_id VARCHAR(120) NOT NULL,
  driver_id INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  latitude NUMERIC(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy NUMERIC(10,2),
  speed NUMERIC(10,2),
  bearing NUMERIC(10,2),
  altitude NUMERIC(10,2),
  provider VARCHAR(30),
  mode VARCHAR(20) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  distance_from_previous_km NUMERIC(10,5) NOT NULL DEFAULT 0,
  CONSTRAINT driver_location_mode_check CHECK (mode IN ('FREE', 'DELIVERY')),
  CONSTRAINT driver_location_accuracy_check CHECK (accuracy IS NULL OR accuracy >= 0),
  CONSTRAINT driver_location_distance_check CHECK (distance_from_previous_km >= 0),
  UNIQUE (driver_id, device_id, client_point_id)
);

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_geofence_overrides (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  authorized_by INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE RESTRICT,
  driver_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  exception_type VARCHAR(40) NOT NULL DEFAULT 'manual_admin',
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  distance_meters INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_override_reason_check CHECK (length(trim(reason)) >= 10),
  CONSTRAINT delivery_override_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_evidence_files (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE RESTRICT,
  mime_type VARCHAR(80) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  contents BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_evidence_size_check CHECK (byte_size BETWEEN 1 AND 2097152),
  CONSTRAINT delivery_evidence_mime_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

CREATE TABLE IF NOT EXISTS pedidos_app_domain_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  aggregate_type VARCHAR(40) NOT NULL,
  aggregate_id VARCHAR(100) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CONSTRAINT domain_events_attempts_check CHECK (publish_attempts >= 0)
);

-- Se añaden permisos sin modificar los roles Delivery.
INSERT INTO pedidos_app_permissions (name, module, action, description)
SELECT value.name, value.module, value.action, value.description
FROM (VALUES
  ('Domicilios: forzar turno', 'Domicilios', 'forzar_turno', 'Finalizar o transferir un turno operativo de forma excepcional'),
  ('Domicilios: override geocerca', 'Domicilios', 'override_geocerca', 'Autorizar una excepción de geocerca con motivo auditable')
) AS value(name, module, action, description)
WHERE NOT EXISTS (
  SELECT 1 FROM pedidos_app_permissions permission
  WHERE permission.module = value.module AND permission.action = value.action
);

INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM pedidos_app_roles role
CROSS JOIN pedidos_app_permissions permission
WHERE role.name IN ('Super Administrador', 'Administrador', 'Admin')
  AND permission.module = 'Domicilios'
  AND permission.action IN ('forzar_turno', 'override_geocerca')
ON CONFLICT DO NOTHING;

ALTER TABLE pedidos_app_delivery_events
  DROP CONSTRAINT IF EXISTS delivery_events_type_check;

ALTER TABLE pedidos_app_delivery_events
  ADD CONSTRAINT delivery_events_type_check CHECK (event_type IN (
    'assigned_own', 'accepted_own', 'delivery_started', 'assigned_external',
    'reassigned', 'handed_to_external', 'external_started', 'delivered', 'cancelled'
  ));

-- Se valida desde ahora sin exigir una reescritura masiva de datos históricos.
ALTER TABLE pedidos_app_orders
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_state_consistency_check;

ALTER TABLE pedidos_app_orders
  ADD CONSTRAINT pedidos_app_orders_delivery_state_consistency_check CHECK (
    lower(COALESCE(delivery_type, '')) <> 'domicilio'
    OR CASE
      WHEN delivery_status = 'Aceptado' AND COALESCE(delivery_provider_type, 'own') = 'own' THEN status = 'Listo'
      WHEN delivery_status = 'En camino' THEN status = 'En camino'
      WHEN delivery_status = 'Entregado' THEN status IN ('Entregado', 'Completado')
      WHEN delivery_status = 'Cancelado' THEN status = 'Cancelado'
      WHEN delivery_status = 'Asignado externo' THEN status = 'Asignado externo'
      WHEN delivery_status = 'Entregado al operador externo' THEN status = 'Entregado al operador externo'
      ELSE TRUE
    END
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_delivery_committed_capacity
  ON pedidos_app_orders (delivery_user_id, delivery_status, created_at)
  WHERE delivery_user_id IS NOT NULL
    AND delivery_provider_type = 'own'
    AND delivery_status IN ('Pendiente', 'Aceptado', 'Recogido', 'En camino');
CREATE INDEX IF NOT EXISTS idx_delivery_profiles_presence_v2
  ON pedidos_app_delivery_profiles (shift_active, last_seen_at DESC, availability_status);
CREATE INDEX IF NOT EXISTS idx_driver_location_points_driver_time
  ON pedidos_app_driver_location_points (driver_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_location_points_received
  ON pedidos_app_driver_location_points (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_idempotency_created
  ON pedidos_app_delivery_idempotency (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON pedidos_app_domain_events (occurred_at, id)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate
  ON pedidos_app_domain_events (aggregate_type, aggregate_id, occurred_at DESC);

ANALYZE pedidos_app_orders;
ANALYZE pedidos_app_delivery_profiles;
ANALYZE pedidos_app_driver_location_points;
ANALYZE pedidos_app_domain_events;
