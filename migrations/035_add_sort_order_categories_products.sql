-- Migration 035: Agregar sort_order a pedidos_app_categories y pedidos_app_products
ALTER TABLE pedidos_app_categories ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Inicializar sort_order en categorías existentes
WITH ranked_categories AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) as new_order
  FROM pedidos_app_categories
)
UPDATE pedidos_app_categories c
SET sort_order = r.new_order
FROM ranked_categories r
WHERE c.id = r.id;

-- Inicializar sort_order en productos existentes
WITH ranked_products AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY category ORDER BY created_at ASC, id ASC) as new_order
  FROM pedidos_app_products
)
UPDATE pedidos_app_products p
SET sort_order = r.new_order
FROM ranked_products r
WHERE p.id = r.id;

-- Índices para optimizar ordenamiento
CREATE INDEX IF NOT EXISTS idx_pedidos_app_categories_sort_order ON pedidos_app_categories (sort_order ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_pedidos_app_products_sort_order ON pedidos_app_products (sort_order ASC, id ASC);
