ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS delivery_completion_radius_meters INTEGER NOT NULL DEFAULT 150;

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_delivery_completion_radius_check;

ALTER TABLE pedidos_app_settings
  ADD CONSTRAINT settings_delivery_completion_radius_check
    CHECK (delivery_completion_radius_meters BETWEEN 50 AND 500);

ANALYZE pedidos_app_settings;
ANALYZE pedidos_app_delivery_locations;
