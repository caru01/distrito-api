-- Migración 031: Auditoría y trazabilidad de compras de inventario
ALTER TABLE pedidos_app_inventory_purchases 
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]'::jsonb;
