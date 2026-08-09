-- Operadores logísticos externos y trazabilidad de asignaciones.

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Activa',
  observations TEXT NOT NULL DEFAULT '',
  default_fee INTEGER NOT NULL DEFAULT 0,
  estimated_delivery_minutes SMALLINT,
  integration_type VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_companies_status_check CHECK (status IN ('Activa', 'Inactiva')),
  CONSTRAINT delivery_companies_default_fee_check CHECK (default_fee >= 0),
  CONSTRAINT delivery_companies_eta_check CHECK (estimated_delivery_minutes IS NULL OR estimated_delivery_minutes BETWEEN 1 AND 1440),
  CONSTRAINT delivery_companies_integration_check CHECK (integration_type IN ('manual', 'api'))
);

ALTER TABLE pedidos_app_orders
  ALTER COLUMN delivery_status TYPE VARCHAR(50),
  ADD COLUMN IF NOT EXISTS delivery_provider_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS external_delivery_company_id INTEGER REFERENCES pedidos_app_delivery_companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_driver_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS external_driver_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS external_vehicle_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS external_delivery_cost INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS external_delivery_notes TEXT,
  ADD COLUMN IF NOT EXISTS external_eta_minutes SMALLINT,
  ADD COLUMN IF NOT EXISTS external_provider_reference VARCHAR(160),
  ADD COLUMN IF NOT EXISTS external_assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_handed_off_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_delivery_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_delivery_confirmed_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_delivery_confirmed_by_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS external_delivery_confirmation_notes TEXT;

UPDATE pedidos_app_orders
SET delivery_provider_type = 'own'
WHERE delivery_user_id IS NOT NULL AND delivery_provider_type IS NULL;

ALTER TABLE pedidos_app_orders
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_status_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_provider_type_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_external_delivery_cost_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_external_eta_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_external_company_check;

ALTER TABLE pedidos_app_orders
  ADD CONSTRAINT pedidos_app_orders_delivery_status_check
    CHECK (delivery_status IN (
      'Pendiente', 'Aceptado', 'Recogido', 'Asignado externo',
      'Entregado al operador externo', 'En camino', 'Entregado', 'Cancelado'
    )),
  ADD CONSTRAINT pedidos_app_orders_delivery_provider_type_check
    CHECK (delivery_provider_type IS NULL OR delivery_provider_type IN ('own', 'external_manual', 'external_api')),
  ADD CONSTRAINT pedidos_app_orders_external_delivery_cost_check CHECK (external_delivery_cost >= 0),
  ADD CONSTRAINT pedidos_app_orders_external_eta_check CHECK (external_eta_minutes IS NULL OR external_eta_minutes BETWEEN 1 AND 1440),
  ADD CONSTRAINT pedidos_app_orders_external_company_check CHECK (
    delivery_provider_type NOT IN ('external_manual', 'external_api') OR external_delivery_company_id IS NOT NULL
  );

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_events (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  provider_type VARCHAR(30),
  delivery_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES pedidos_app_delivery_companies(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  actor_name VARCHAR(160),
  driver_name VARCHAR(160),
  driver_phone VARCHAR(30),
  vehicle_id VARCHAR(80),
  external_cost INTEGER,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_events_type_check CHECK (event_type IN (
    'assigned_own', 'assigned_external', 'reassigned', 'handed_to_external',
    'external_started', 'delivered', 'cancelled'
  )),
  CONSTRAINT delivery_events_provider_check CHECK (
    provider_type IS NULL OR provider_type IN ('own', 'external_manual', 'external_api')
  ),
  CONSTRAINT delivery_events_cost_check CHECK (external_cost IS NULL OR external_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_delivery_companies_status_name
  ON pedidos_app_delivery_companies (status, name);
CREATE INDEX IF NOT EXISTS idx_orders_external_company_status
  ON pedidos_app_orders (external_delivery_company_id, delivery_status, created_at DESC)
  WHERE external_delivery_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_delivery_provider_status
  ON pedidos_app_orders (delivery_provider_type, delivery_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_events_order_time
  ON pedidos_app_delivery_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_events_company_time
  ON pedidos_app_delivery_events (company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

ANALYZE pedidos_app_delivery_companies;
ANALYZE pedidos_app_orders;
ANALYZE pedidos_app_delivery_events;
