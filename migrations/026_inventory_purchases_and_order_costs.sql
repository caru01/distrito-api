-- Migration 026: Inventory Purchases and Order Item Costs
BEGIN;

-- 1. Create inventory purchases table
CREATE TABLE IF NOT EXISTS pedidos_app_inventory_purchases (
    id SERIAL PRIMARY KEY,
    product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
    total_cost NUMERIC(10,2) NOT NULL CHECK (total_cost >= 0),
    supplier VARCHAR(255),
    purchase_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255)
);

-- 2. Create order item costs table to freeze profitability historically
CREATE TABLE IF NOT EXISTS pedidos_app_order_item_costs (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    component_product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMIT;
