ALTER TABLE pedidos_app_delivery_profiles
  ADD COLUMN IF NOT EXISTS max_active_orders SMALLINT NOT NULL DEFAULT 5;

ALTER TABLE pedidos_app_delivery_profiles
  DROP CONSTRAINT IF EXISTS delivery_profiles_max_active_orders_check;

ALTER TABLE pedidos_app_delivery_profiles
  ADD CONSTRAINT delivery_profiles_max_active_orders_check
    CHECK (max_active_orders BETWEEN 1 AND 5);

DROP INDEX IF EXISTS idx_delivery_one_active_per_driver;

ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS kitchen_address VARCHAR(500),
  ADD COLUMN IF NOT EXISTS kitchen_place_id VARCHAR(255);

UPDATE pedidos_app_settings
SET kitchen_address = COALESCE(NULLIF(kitchen_address, ''), address)
WHERE id = 1;

ANALYZE pedidos_app_delivery_profiles;
ANALYZE pedidos_app_orders;
