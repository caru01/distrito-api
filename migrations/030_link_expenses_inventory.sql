-- 030_link_expenses_inventory.sql
BEGIN;

ALTER TABLE pedidos_app_inventory_purchases 
  ADD COLUMN IF NOT EXISTS expense_id INTEGER REFERENCES pedidos_app_expenses(id) ON DELETE CASCADE;

COMMIT;