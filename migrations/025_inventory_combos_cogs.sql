-- Migration 025: Inventory, Combos, and COGS
BEGIN;

-- 1. Add average_cost to products (Cost per unit)
ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS average_cost NUMERIC(10,2) DEFAULT 0;

-- 2. Add total_cogs to orders (Total Cost of Goods Sold for the order)
ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS total_cogs NUMERIC(10,2) DEFAULT 0;

-- 3. Create combo components table
CREATE TABLE IF NOT EXISTS pedidos_app_combo_components (
    id SERIAL PRIMARY KEY,
    combo_product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    component_product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(combo_product_id, component_product_id)
);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_combo_components_updated_at') THEN
        CREATE TRIGGER update_combo_components_updated_at
        BEFORE UPDATE ON pedidos_app_combo_components
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END
$$;

COMMIT;
