CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_one_active_per_driver
  ON pedidos_app_orders (delivery_user_id)
  WHERE delivery_user_id IS NOT NULL
    AND delivery_status IN ('Aceptado', 'Recogido', 'En camino');

CREATE INDEX IF NOT EXISTS idx_delivery_locations_retention
  ON pedidos_app_delivery_locations (recorded_at);

ANALYZE pedidos_app_orders;
ANALYZE pedidos_app_delivery_locations;
