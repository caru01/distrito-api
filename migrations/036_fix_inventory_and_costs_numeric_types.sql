-- Migration 036: Fix inventory, purchases and stock movement numeric column types
-- Permite costos unitarios y cantidades decimales (evita error 'invalid input syntax for type integer')
BEGIN;

-- 1. pedidos_app_inventory: Asegurar costos y cantidades decimales
ALTER TABLE pedidos_app_inventory 
  ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING unit_cost::numeric,
  ALTER COLUMN average_cost TYPE NUMERIC(14,4) USING average_cost::numeric;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pedidos_app_inventory' AND column_name = 'stock' AND data_type != 'numeric'
  ) THEN
    ALTER TABLE pedidos_app_inventory ALTER COLUMN stock TYPE NUMERIC(14,4) USING stock::numeric;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pedidos_app_inventory' AND column_name = 'min_stock' AND data_type != 'numeric'
  ) THEN
    ALTER TABLE pedidos_app_inventory ALTER COLUMN min_stock TYPE NUMERIC(14,4) USING min_stock::numeric;
  END IF;
END $$;

-- 2. pedidos_app_inventory_purchases: Permitir cantidades y costos fraccionarios/decimales
ALTER TABLE pedidos_app_inventory_purchases 
  ALTER COLUMN quantity TYPE NUMERIC(14,4) USING quantity::numeric,
  ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING unit_cost::numeric,
  ALTER COLUMN total_cost TYPE NUMERIC(14,2) USING total_cost::numeric;

-- 3. pedidos_app_product_stock_movements: Permitir cantidades y balances decimales en Kardex
ALTER TABLE pedidos_app_product_stock_movements 
  ALTER COLUMN quantity TYPE NUMERIC(14,4) USING quantity::numeric,
  ALTER COLUMN balance_after TYPE NUMERIC(14,4) USING balance_after::numeric;

-- 4. pedidos_app_products: Asegurar que el costo unitario de inventario soporte decimales
ALTER TABLE pedidos_app_products 
  ALTER COLUMN inventory_unit_cost TYPE NUMERIC(14,4) USING inventory_unit_cost::numeric;

-- 5. pedidos_app_order_item_costs: Asegurar soporte decimal completo
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pedidos_app_order_item_costs') THEN
    ALTER TABLE pedidos_app_order_item_costs 
      ALTER COLUMN quantity TYPE NUMERIC(14,4) USING quantity::numeric,
      ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING unit_cost::numeric,
      ALTER COLUMN total_cost TYPE NUMERIC(14,2) USING total_cost::numeric;
  END IF;
END $$;

-- 6. Tablas auxiliares (si existen en el entorno)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pedidos_app_rendimientos') THEN
    ALTER TABLE pedidos_app_rendimientos 
      ALTER COLUMN costo_compra TYPE NUMERIC(14,2) USING costo_compra::numeric;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pedidos_app_purchases') THEN
    ALTER TABLE pedidos_app_purchases 
      ALTER COLUMN total_amount TYPE NUMERIC(14,2) USING total_amount::numeric,
      ALTER COLUMN iva_amount TYPE NUMERIC(14,2) USING iva_amount::numeric;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pedidos_app_purchase_items') THEN
    ALTER TABLE pedidos_app_purchase_items 
      ALTER COLUMN quantity TYPE NUMERIC(14,4) USING quantity::numeric,
      ALTER COLUMN unit_cost TYPE NUMERIC(14,4) USING unit_cost::numeric,
      ALTER COLUMN total_cost TYPE NUMERIC(14,2) USING total_cost::numeric,
      ALTER COLUMN iva_amount TYPE NUMERIC(14,2) USING iva_amount::numeric;
  END IF;
END $$;

COMMIT;
