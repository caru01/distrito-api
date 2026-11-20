-- Migration 050: Support Custom Burgers (Modo Chef) System Master Product & Category
-- Reversible: Yes

BEGIN;

-- 1. Asegurar la categoría 'Modo Chef' en pedidos_app_categories
INSERT INTO pedidos_app_categories (name, description, image, status, sort_order)
SELECT 'Modo Chef', 'Hamburguesas y productos personalizados armados desde cero', '👨‍🍳', 'Activa', 1
WHERE NOT EXISTS (
    SELECT 1 FROM pedidos_app_categories WHERE name = 'Modo Chef'
);

-- 2. Asegurar el producto maestro del sistema para pedidos personalizados en pedidos_app_products
INSERT INTO pedidos_app_products (id, title, price, category, status, image, is_featured, sort_order)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, 'Hamburguesa Modo Chef', 0, 'Modo Chef', 'Activo', '', true, 1
WHERE NOT EXISTS (
    SELECT 1 FROM pedidos_app_products WHERE id = '00000000-0000-4000-8000-000000000001'::uuid
);

COMMIT;
