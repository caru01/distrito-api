-- 038_rappi_orders_integration.sql
-- Integración de Rappi Orders API y Webhooks en tiempo real

CREATE TABLE IF NOT EXISTS pedidos_app_rappi_config (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  store_id TEXT NOT NULL DEFAULT '',
  webhook_secret TEXT NOT NULL DEFAULT '',
  environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  auto_accept BOOLEAN NOT NULL DEFAULT TRUE,
  api_base_url TEXT DEFAULT 'https://api-stage.rappi.com',
  last_sync_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Asegurar registro inicial único
INSERT INTO pedidos_app_rappi_config (id, client_id, client_secret, store_id, environment, is_active, auto_accept)
VALUES (1, '', '', '', 'sandbox', false, true)
ON CONFLICT (id) DO NOTHING;

-- Registro y auditoría de eventos de Rappi
CREATE TABLE IF NOT EXISTS pedidos_app_rappi_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  rappi_order_id VARCHAR(120),
  payload JSONB,
  response_status VARCHAR(40),
  error_message TEXT,
  order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Asegurar columna external_provider_reference en pedidos_app_orders
ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS external_provider_reference VARCHAR(160);
CREATE INDEX IF NOT EXISTS idx_pedidos_app_orders_external_ref ON pedidos_app_orders(external_provider_reference);

-- Asegurar operador logístico Rappi en pedidos_app_delivery_companies
INSERT INTO pedidos_app_delivery_companies (name, phone, status, integration_type)
VALUES ('Rappi', '018000', 'Activa', 'api')
ON CONFLICT (name) DO NOTHING;
