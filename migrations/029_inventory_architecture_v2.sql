-- Migration 029: Decoupled Inventory Architecture (Products vs Inventory Items)
BEGIN;

-- 1. Create the new recipes table linking Sales Products to Inventory Items
CREATE TABLE IF NOT EXISTS pedidos_app_product_recipes (
    id SERIAL PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    quantity NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
    is_controlled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, inventory_id)
);

-- Trigger to update updated_at for recipes
CREATE OR REPLACE FUNCTION update_recipes_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_recipes_updated_at') THEN
        CREATE TRIGGER update_recipes_updated_at
        BEFORE UPDATE ON pedidos_app_product_recipes
        FOR EACH ROW EXECUTE FUNCTION update_recipes_updated_at_column();
    END IF;
END
$$;

-- 2. Adapt Inventory Purchases to point to inventory_id
ALTER TABLE pedidos_app_inventory_purchases 
  ADD COLUMN IF NOT EXISTS inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE;
ALTER TABLE pedidos_app_inventory_purchases ALTER COLUMN product_id DROP NOT NULL;

-- 3. Adapt Stock Movements (Kardex) to point to inventory_id
ALTER TABLE pedidos_app_product_stock_movements 
  ADD COLUMN IF NOT EXISTS inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE;
ALTER TABLE pedidos_app_product_stock_movements ALTER COLUMN product_id DROP NOT NULL;

-- 4. Adapt Order Item Costs to track the consumed inventory_id
ALTER TABLE pedidos_app_order_item_costs 
  ADD COLUMN IF NOT EXISTS inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE;

-- 4.5. Add average_cost and track_stock to pedidos_app_inventory
ALTER TABLE pedidos_app_inventory 
  ADD COLUMN IF NOT EXISTS average_cost NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS track_stock BOOLEAN DEFAULT TRUE;

-- 5. Safe Legacy Data Migration (for the existing 1 purchase/movement in production)
COMMIT;
BEGIN;
-- Create equivalent inventory items for any legacy purchases
INSERT INTO pedidos_app_inventory (name, unit, stock, average_cost, track_stock)
SELECT 
    'INSUMO LEGACY: ' || p.title, 
    'unidad', 
    p.stock, 
    p.average_cost, 
    true
FROM pedidos_app_products p
JOIN pedidos_app_inventory_purchases pur ON pur.product_id = p.id
WHERE pur.inventory_id IS NULL
AND NOT EXISTS (
    SELECT 1 FROM pedidos_app_inventory i WHERE i.name = 'INSUMO LEGACY: ' || p.title
);

-- Link legacy purchases
UPDATE pedidos_app_inventory_purchases pur
SET inventory_id = inv.id
FROM pedidos_app_products p
JOIN pedidos_app_inventory inv ON inv.name = 'INSUMO LEGACY: ' || p.title
WHERE pur.product_id = p.id AND pur.inventory_id IS NULL;

-- Link legacy movements
UPDATE pedidos_app_product_stock_movements mov
SET inventory_id = inv.id
FROM pedidos_app_products p
JOIN pedidos_app_inventory inv ON inv.name = 'INSUMO LEGACY: ' || p.title
WHERE mov.product_id = p.id AND mov.inventory_id IS NULL;

COMMIT;
