ALTER TABLE pedidos_app_delivery_company_drivers
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_company_drivers_user_id
  ON pedidos_app_delivery_company_drivers(user_id);

ALTER TABLE pedidos_app_users
  ADD COLUMN IF NOT EXISTS external_company_id INTEGER REFERENCES pedidos_app_delivery_companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_driver_id INTEGER REFERENCES pedidos_app_delivery_company_drivers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_external_company
  ON pedidos_app_users(external_company_id, external_driver_id);
