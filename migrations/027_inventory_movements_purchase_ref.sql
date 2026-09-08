-- Migration 027: Inventory Movements Purchase Reference & Indexes
BEGIN;

-- 1. Add purchase_id to product stock movements
ALTER TABLE pedidos_app_product_stock_movements 
ADD COLUMN IF NOT EXISTS purchase_id INTEGER REFERENCES pedidos_app_inventory_purchases(id) ON DELETE SET NULL;

-- 2. Add notes to inventory purchases
ALTER TABLE pedidos_app_inventory_purchases 
ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3. Indexes for fast report queries and delta lookups
CREATE INDEX IF NOT EXISTS idx_order_item_costs_order_id ON pedidos_app_order_item_costs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_costs_product_id ON pedidos_app_order_item_costs(product_id);
CREATE INDEX IF NOT EXISTS idx_order_item_costs_comp_id ON pedidos_app_order_item_costs(component_product_id);
CREATE INDEX IF NOT EXISTS idx_combo_components_combo_id ON pedidos_app_combo_components(combo_product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_purchases_product_id ON pedidos_app_inventory_purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_id ON pedidos_app_product_stock_movements(order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_purchase_id ON pedidos_app_product_stock_movements(purchase_id);

COMMIT;
