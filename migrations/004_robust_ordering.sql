ALTER TABLE pedidos_app_sessions
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS device_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE pedidos_app_users
  ADD COLUMN IF NOT EXISTS max_active_sessions SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS session_idle_minutes INTEGER NOT NULL DEFAULT 60;

ALTER TABLE pedidos_app_users
  DROP CONSTRAINT IF EXISTS pedidos_app_users_max_active_sessions_check;
ALTER TABLE pedidos_app_users
  ADD CONSTRAINT pedidos_app_users_max_active_sessions_check
  CHECK (max_active_sessions BETWEEN 1 AND 3);

ALTER TABLE pedidos_app_users
  DROP CONSTRAINT IF EXISTS pedidos_app_users_session_idle_minutes_check;
ALTER TABLE pedidos_app_users
  ADD CONSTRAINT pedidos_app_users_session_idle_minutes_check
  CHECK (session_idle_minutes BETWEEN 15 AND 480);

ALTER TABLE pedidos_app_products
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(32),
  ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS inventory_unit VARCHAR(30) NOT NULL DEFAULT 'unidad',
  ADD COLUMN IF NOT EXISTS inventory_unit_cost INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS web_primary_color VARCHAR(7) NOT NULL DEFAULT '#D4A017',
  ADD COLUMN IF NOT EXISTS web_background_color VARCHAR(7) NOT NULL DEFAULT '#0D0D0D',
  ADD COLUMN IF NOT EXISTS web_surface_color VARCHAR(7) NOT NULL DEFAULT '#171717',
  ADD COLUMN IF NOT EXISTS web_text_color VARCHAR(7) NOT NULL DEFAULT '#FFFFFF',
  ADD COLUMN IF NOT EXISTS admin_primary_color VARCHAR(7) NOT NULL DEFAULT '#D4A017',
  ADD COLUMN IF NOT EXISTS admin_background_color VARCHAR(7) NOT NULL DEFAULT '#0D0D0D',
  ADD COLUMN IF NOT EXISTS admin_surface_color VARCHAR(7) NOT NULL DEFAULT '#151515',
  ADD COLUMN IF NOT EXISTS admin_text_color VARCHAR(7) NOT NULL DEFAULT '#FFFFFF';

CREATE TABLE IF NOT EXISTS pedidos_app_product_stock_movements (
  id BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE SET NULL,
  movement_type VARCHAR(30) NOT NULL,
  quantity INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT,
  created_by VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique
  ON pedidos_app_products (barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE INDEX IF NOT EXISTS idx_products_inventory_status
  ON pedidos_app_products (track_stock, stock, low_stock_threshold) WHERE status = 'Activo';
CREATE INDEX IF NOT EXISTS idx_product_stock_movements_product_created
  ON pedidos_app_product_stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_active_last_active
  ON pedidos_app_sessions (user_id, last_active DESC) WHERE status = 'Activa';
CREATE INDEX IF NOT EXISTS idx_sessions_device
  ON pedidos_app_sessions (user_id, device_id) WHERE status = 'Activa';
CREATE INDEX IF NOT EXISTS idx_orders_public_tracking
  ON pedidos_app_orders (id, customer_phone, updated_at DESC);

ANALYZE pedidos_app_products;
ANALYZE pedidos_app_sessions;
ANALYZE pedidos_app_orders;
