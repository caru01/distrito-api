INSERT INTO pedidos_app_roles (name, description, is_system_role)
VALUES ('Domiciliario', 'Acceso exclusivo a la aplicación de entregas', TRUE)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    is_system_role = TRUE;

INSERT INTO pedidos_app_permissions (name, module, action, description)
SELECT values_to_insert.name, values_to_insert.module, values_to_insert.action, values_to_insert.description
FROM (VALUES
  ('Domicilios: ver', 'Domicilios', 'ver', 'Consultar el mapa y la operación de domicilios'),
  ('Domicilios: asignar', 'Domicilios', 'asignar', 'Asignar y reasignar pedidos a domiciliarios')
) AS values_to_insert(name, module, action, description)
WHERE NOT EXISTS (
  SELECT 1
  FROM pedidos_app_permissions permission
  WHERE permission.module = values_to_insert.module
    AND permission.action = values_to_insert.action
);

INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM pedidos_app_roles role
CROSS JOIN pedidos_app_permissions permission
WHERE role.name IN ('Super Administrador', 'Administrador', 'Admin')
  AND permission.module = 'Domicilios'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  vehicle_name VARCHAR(120),
  vehicle_type VARCHAR(50),
  plate VARCHAR(30),
  documents JSONB NOT NULL DEFAULT '{}'::jsonb,
  availability_status VARCHAR(20) NOT NULL DEFAULT 'Desconectado',
  current_latitude NUMERIC(10,7),
  current_longitude NUMERIC(10,7),
  current_accuracy NUMERIC(10,2),
  last_location_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  rating_sum NUMERIC(12,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_profiles_availability_check
    CHECK (availability_status IN ('Libre', 'Ocupado', 'Desconectado'))
);

ALTER TABLE pedidos_app_orders
  ADD COLUMN IF NOT EXISTS delivery_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
  ADD COLUMN IF NOT EXISTS delivery_fee INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_reference TEXT,
  ADD COLUMN IF NOT EXISTS change_required INTEGER,
  ADD COLUMN IF NOT EXISTS delivery_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS on_the_way_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT,
  ADD COLUMN IF NOT EXISTS delivery_evidence TEXT,
  ADD COLUMN IF NOT EXISTS delivery_rating SMALLINT,
  ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS delivery_duration_seconds INTEGER;

ALTER TABLE pedidos_app_orders
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_status_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_fee_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_rating_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_distance_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_duration_check;

ALTER TABLE pedidos_app_orders
  ADD CONSTRAINT pedidos_app_orders_delivery_status_check
    CHECK (delivery_status IN ('Pendiente', 'Aceptado', 'Recogido', 'En camino', 'Entregado', 'Cancelado')),
  ADD CONSTRAINT pedidos_app_orders_delivery_fee_check CHECK (delivery_fee >= 0),
  ADD CONSTRAINT pedidos_app_orders_delivery_rating_check CHECK (delivery_rating IS NULL OR delivery_rating BETWEEN 1 AND 5),
  ADD CONSTRAINT pedidos_app_orders_delivery_distance_check CHECK (delivery_distance_km IS NULL OR delivery_distance_km >= 0),
  ADD CONSTRAINT pedidos_app_orders_delivery_duration_check CHECK (delivery_duration_seconds IS NULL OR delivery_duration_seconds >= 0);

UPDATE pedidos_app_orders
SET delivery_status = CASE
  WHEN status = 'Cancelado' THEN 'Cancelado'
  WHEN status IN ('Entregado', 'Completado') THEN 'Entregado'
  WHEN status = 'En camino' THEN 'En camino'
  ELSE COALESCE(NULLIF(delivery_status, ''), 'Pendiente')
END;

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_locations (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  latitude NUMERIC(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy NUMERIC(10,2),
  speed NUMERIC(10,2),
  heading NUMERIC(10,2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pedidos_app_push_subscriptions
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS audience VARCHAR(30) NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_delivery_available_orders
  ON pedidos_app_orders (delivery_status, status, created_at)
  WHERE lower(delivery_type) = 'domicilio' AND delivery_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_assigned_orders
  ON pedidos_app_orders (delivery_user_id, delivery_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_profiles_presence
  ON pedidos_app_delivery_profiles (availability_status, last_location_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_order_time
  ON pedidos_app_delivery_locations (order_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_user_time
  ON pedidos_app_delivery_locations (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_audience_user
  ON pedidos_app_push_subscriptions (audience, user_id);

ANALYZE pedidos_app_orders;
ANALYZE pedidos_app_delivery_profiles;
ANALYZE pedidos_app_delivery_locations;
