-- Migration 051: Role Permissions Matrix Alignment for Cocina, Mesero, Inventario, Compras, Contabilidad y Gerente
-- Reversible: Yes

BEGIN;

-- 1. Rol Cocina: Pedidos ver y editar (avanzar a en_cocina, listo, etc.)
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Cocina'
  AND p.module = 'Pedidos'
  AND p.action IN ('ver', 'editar', 'imprimir')
ON CONFLICT DO NOTHING;

-- 2. Rol Mesero: Pedidos ver, crear y editar
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Mesero'
  AND (
    (p.module = 'Pedidos' AND p.action IN ('ver', 'crear', 'editar'))
    OR (p.module = 'Productos' AND p.action = 'ver')
    OR (p.module = 'Categorias' AND p.action = 'ver')
  )
ON CONFLICT DO NOTHING;

-- 3. Rol Inventario: Gestión completa de stock, recetas y kardex
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Inventario'
  AND p.module IN ('Inventario', 'Recetas', 'Rendimientos')
ON CONFLICT DO NOTHING;

-- 4. Rol Compras: Proveedores, insumos y compras
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Compras'
  AND (
    (p.module = 'Inventario' AND p.action IN ('ver', 'compras'))
    OR (p.module = 'Gastos' AND p.action IN ('ver', 'crear'))
  )
ON CONFLICT DO NOTHING;

-- 5. Rol Contabilidad: Cierre de caja, gastos, reportes y nómina
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Contabilidad'
  AND (
    p.module IN ('Cierre Contable', 'Gastos', 'Reportes', 'Nomina')
    OR (p.module = 'Pedidos' AND p.action = 'ver')
  )
ON CONFLICT DO NOTHING;

-- 6. Rol Gerente: Gestión operativa integral
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Gerente'
  AND p.module IN ('Dashboard', 'Pedidos', 'Productos', 'Categorias', 'Inventario', 'Clientes', 'Cierre Contable', 'Gastos', 'Reportes', 'Nomina', 'Horarios', 'Anuncios', 'Empresas Domicilios')
ON CONFLICT DO NOTHING;

COMMIT;
