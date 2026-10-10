-- Migration 040: Convert inventory purchases purchase_date to DATE to prevent timezone shift
BEGIN;

ALTER TABLE pedidos_app_inventory_purchases 
  ALTER COLUMN purchase_date TYPE DATE USING (purchase_date AT TIME ZONE 'UTC')::date;

ALTER TABLE pedidos_app_inventory_purchases 
  ALTER COLUMN purchase_date SET DEFAULT CURRENT_DATE;

COMMIT;
