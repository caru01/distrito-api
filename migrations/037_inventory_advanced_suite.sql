-- Migration 037: Advanced Inventory Suite for Distrito BG
-- Suppliers, Sub-recipes (Production), Modifier Recipes, Waste Classification & Stock Audit Reconcile

BEGIN;

-- 1. Suppliers Directory
CREATE TABLE IF NOT EXISTS pedidos_app_suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    nit TEXT,
    address TEXT,
    category TEXT DEFAULT 'General',
    payment_terms TEXT DEFAULT 'Contado',
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed existing suppliers from purchases if any
INSERT INTO pedidos_app_suppliers (name)
SELECT DISTINCT TRIM(supplier)
FROM pedidos_app_inventory_purchases
WHERE supplier IS NOT NULL AND TRIM(supplier) <> ''
ON CONFLICT (name) DO NOTHING;

-- Link purchases to suppliers if column doesn't exist
ALTER TABLE pedidos_app_inventory_purchases
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES pedidos_app_suppliers(id) ON DELETE SET NULL;

-- 2. Enhanced Insumos: prepared items and default conversion
ALTER TABLE pedidos_app_inventory
  ADD COLUMN IF NOT EXISTS is_prepared BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS purchase_unit TEXT,
  ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(12,4) DEFAULT 1;

-- 3. Sub-recipes (Production of internal preparations like sauces, burger patties, marinades)
-- Links a Prepared Insumo (target_inventory_id) to its raw Insumos (ingredient_inventory_id)
CREATE TABLE IF NOT EXISTS pedidos_app_subrecipes (
    id SERIAL PRIMARY KEY,
    target_inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    ingredient_inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    quantity NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_inventory_id, ingredient_inventory_id)
);

-- Production Batches History
CREATE TABLE IF NOT EXISTS pedidos_app_production_batches (
    id SERIAL PRIMARY KEY,
    target_inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    quantity_produced NUMERIC(12,4) NOT NULL CHECK (quantity_produced > 0),
    total_cost NUMERIC(14,2) DEFAULT 0,
    unit_cost NUMERIC(14,4) DEFAULT 0,
    produced_by TEXT DEFAULT 'Cocina',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Modifier / Addition Recipes (Deductions for extra toppings: tocineta, queso, salsas extra)
CREATE TABLE IF NOT EXISTS pedidos_app_modifier_recipes (
    id SERIAL PRIMARY KEY,
    modifier_name TEXT NOT NULL,
    inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    quantity NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
    is_controlled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(modifier_name, inventory_id)
);

-- 5. Enhanced Waste / Movement Classification
ALTER TABLE pedidos_app_product_stock_movements
  ADD COLUMN IF NOT EXISTS waste_reason TEXT,
  ADD COLUMN IF NOT EXISTS batch_id INT REFERENCES pedidos_app_production_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,2) DEFAULT 0;

-- 6. Physical Inventory Audits / Reconciliations History
CREATE TABLE IF NOT EXISTS pedidos_app_inventory_audits (
    id SERIAL PRIMARY KEY,
    audit_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    audited_by TEXT DEFAULT 'Administrador',
    notes TEXT,
    items_count INT DEFAULT 0,
    total_discrepancy_cost NUMERIC(14,2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos_app_inventory_audit_items (
    id SERIAL PRIMARY KEY,
    audit_id INT NOT NULL REFERENCES pedidos_app_inventory_audits(id) ON DELETE CASCADE,
    inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
    system_stock NUMERIC(12,4) NOT NULL,
    counted_stock NUMERIC(12,4) NOT NULL,
    difference NUMERIC(12,4) NOT NULL,
    unit_cost NUMERIC(14,4) DEFAULT 0,
    cost_difference NUMERIC(14,2) DEFAULT 0
);

COMMIT;
