ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS default_max_driver_capacity SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sse_reconnect_initial_ms INTEGER NOT NULL DEFAULT 1500,
  ADD COLUMN IF NOT EXISTS sse_reconnect_max_ms INTEGER NOT NULL DEFAULT 30000;

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_default_driver_capacity_check,
  DROP CONSTRAINT IF EXISTS settings_sse_reconnect_initial_check,
  DROP CONSTRAINT IF EXISTS settings_sse_reconnect_max_check,
  ADD CONSTRAINT settings_default_driver_capacity_check CHECK (default_max_driver_capacity BETWEEN 1 AND 5),
  ADD CONSTRAINT settings_sse_reconnect_initial_check CHECK (sse_reconnect_initial_ms BETWEEN 500 AND 10000),
  ADD CONSTRAINT settings_sse_reconnect_max_check CHECK (sse_reconnect_max_ms BETWEEN 5000 AND 120000),
  ADD CONSTRAINT settings_sse_reconnect_order_check CHECK (sse_reconnect_max_ms >= sse_reconnect_initial_ms);

ANALYZE pedidos_app_settings;
