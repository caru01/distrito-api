-- Migración 032: Mensajeros / Domiciliarios de empresas de domicilios externas

CREATE TABLE IF NOT EXISTS pedidos_app_delivery_company_drivers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES pedidos_app_delivery_companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  vehicle_type VARCHAR(40) NOT NULL DEFAULT 'Moto',
  vehicle_plate VARCHAR(30),
  document_id VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'Activo',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT company_driver_status_check CHECK (status IN ('Activo', 'Inactivo')),
  CONSTRAINT company_driver_vehicle_check CHECK (vehicle_type IN ('Moto', 'Bicicleta', 'Carro', 'A pie', 'Otro'))
);

CREATE INDEX IF NOT EXISTS idx_company_drivers_company_id ON pedidos_app_delivery_company_drivers(company_id);

ALTER TABLE pedidos_app_orders
  ADD COLUMN IF NOT EXISTS external_driver_id INTEGER REFERENCES pedidos_app_delivery_company_drivers(id) ON DELETE SET NULL;
