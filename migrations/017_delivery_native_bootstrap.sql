CREATE TABLE IF NOT EXISTS pedidos_app_delivery_native_bootstrap (
  code_hash VARCHAR(64) PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_native_bootstrap_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_delivery_native_bootstrap_expiry
  ON pedidos_app_delivery_native_bootstrap (expires_at)
  WHERE consumed_at IS NULL;

ANALYZE pedidos_app_delivery_native_bootstrap;
