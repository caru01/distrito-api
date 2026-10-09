-- Migración 039: Convertir columnas timestamp sin zona a TIMESTAMPTZ
-- Asegura que todas las fechas operativas (pedidos, clientes, gastos, etc.) se almacenen y lean
-- en UTC canónico, permitiendo conversiones exactas a la zona de Colombia (America/Bogota).

ALTER TABLE pedidos_app_orders 
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING (created_at AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING (CASE WHEN updated_at IS NOT NULL THEN (updated_at AT TIME ZONE 'UTC') ELSE NULL END),
  ALTER COLUMN delivered_at TYPE TIMESTAMPTZ USING (CASE WHEN delivered_at IS NOT NULL THEN (delivered_at AT TIME ZONE 'UTC') ELSE NULL END),
  ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING (CASE WHEN completed_at IS NOT NULL THEN (completed_at AT TIME ZONE 'UTC') ELSE NULL END);

ALTER TABLE pedidos_app_orders ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE pedidos_app_orders ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE pedidos_app_customers
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING (created_at AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING (CASE WHEN updated_at IS NOT NULL THEN (updated_at AT TIME ZONE 'UTC') ELSE NULL END);

ALTER TABLE pedidos_app_customers ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE pedidos_app_customers ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE pedidos_app_expenses
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING (created_at AT TIME ZONE 'UTC');

ALTER TABLE pedidos_app_expenses ALTER COLUMN created_at SET DEFAULT NOW();
