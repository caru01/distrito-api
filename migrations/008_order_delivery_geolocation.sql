ALTER TABLE pedidos_app_orders
  ADD COLUMN IF NOT EXISTS delivery_latitude NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_longitude NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_place_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS delivery_location_adjusted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_apartment VARCHAR(50),
  ADD COLUMN IF NOT EXISTS delivery_tower VARCHAR(50),
  ADD COLUMN IF NOT EXISTS delivery_floor VARCHAR(30);

ALTER TABLE pedidos_app_orders
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_coordinates_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_latitude_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_orders_delivery_longitude_check;

ALTER TABLE pedidos_app_orders
  ADD CONSTRAINT pedidos_app_orders_delivery_coordinates_check
    CHECK ((delivery_latitude IS NULL) = (delivery_longitude IS NULL)),
  ADD CONSTRAINT pedidos_app_orders_delivery_latitude_check
    CHECK (delivery_latitude IS NULL OR delivery_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT pedidos_app_orders_delivery_longitude_check
    CHECK (delivery_longitude IS NULL OR delivery_longitude BETWEEN -180 AND 180);

CREATE INDEX IF NOT EXISTS idx_orders_delivery_place_id
  ON pedidos_app_orders (delivery_place_id)
  WHERE delivery_place_id IS NOT NULL;

ANALYZE pedidos_app_orders;
