ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS store_latitude NUMERIC(10,7) NOT NULL DEFAULT 10.4631000,
  ADD COLUMN IF NOT EXISTS store_longitude NUMERIC(10,7) NOT NULL DEFAULT -73.2532000;

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS pedidos_app_settings_store_latitude_check,
  DROP CONSTRAINT IF EXISTS pedidos_app_settings_store_longitude_check;

ALTER TABLE pedidos_app_settings
  ADD CONSTRAINT pedidos_app_settings_store_latitude_check
    CHECK (store_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT pedidos_app_settings_store_longitude_check
    CHECK (store_longitude BETWEEN -180 AND 180);
