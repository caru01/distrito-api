-- Migration 033: Update Roles and Permissions Matrix
-- Distrito BG - Sistema de Control de Acceso Unificado

BEGIN;

-- 1. Insertar permisos nuevos y especializados en pedidos_app_permissions
INSERT INTO pedidos_app_permissions (module, action, name, description)
VALUES
  -- Empresas de Domicilios
  ('Empresas Domicilios', 'ver', 'Empresas Domicilios - ver', 'Consultar operadores y empresas de domicilios aliadas'),
  ('Empresas Domicilios', 'crear', 'Empresas Domicilios - crear', 'Registrar nueva empresa de domicilios'),
  ('Empresas Domicilios', 'editar', 'Empresas Domicilios - editar', 'Modificar datos, tarifas y tiempos de entrega de empresas'),
  ('Empresas Domicilios', 'eliminar', 'Empresas Domicilios - eliminar', 'Desactivar o eliminar empresas de domicilios'),
  ('Empresas Domicilios', 'mensajeros', 'Empresas Domicilios - mensajeros', 'Gestionar mensajeros y domiciliarios externos'),

  -- Anuncios y Promociones
  ('Anuncios', 'ver', 'Anuncios - ver', 'Consultar campañas y anuncios de la tienda virtual'),
  ('Anuncios', 'crear', 'Anuncios - crear', 'Diseñar y programar nuevos anuncios promocionales'),
  ('Anuncios', 'editar', 'Anuncios - editar', 'Modificar estado, vigencia y contenido de anuncios'),
  ('Anuncios', 'eliminar', 'Anuncios - eliminar', 'Eliminar anuncios del sistema'),

  -- Horarios y Festivos
  ('Horarios', 'ver', 'Horarios - ver', 'Consultar horarios de atención y días festivos'),
  ('Horarios', 'editar', 'Horarios - editar', 'Modificar horarios semanales y excepciones de servicio'),

  -- Inventario Especializado
  ('Inventario', 'compras', 'Inventario - compras', 'Registrar y gestionar compras de insumos a proveedores'),
  ('Inventario', 'ajustar_stock', 'Inventario - ajustar stock', 'Realizar ajustes manuales de stock y registrar mermas'),
  ('Inventario', 'recetas', 'Inventario - recetas', 'Crear, editar y costear recetas de productos de venta'),
  ('Inventario', 'kardex', 'Inventario - kardex', 'Consultar trazabilidad detallada y movimientos de inventario'),
  ('Inventario', 'rentabilidad', 'Inventario - rentabilidad', 'Analizar costos, márgenes brutos y rentabilidad de la carta'),

  -- Pedidos Especializado
  ('Pedidos', 'imprimir', 'Pedidos - imprimir', 'Imprimir comandas y facturas/tickets de pedidos'),

  -- Gastos Especializado
  ('Gastos', 'aprobar', 'Gastos - aprobar', 'Aprobar o auditar gastos registrados'),

  -- Cierre Contable Especializado
  ('Cierre Contable', 'cerrar_caja', 'Cierre Contable - cerrar caja', 'Ejecutar el arqueo y cierre diario de caja'),
  ('Cierre Contable', 'exportar', 'Cierre Contable - exportar', 'Exportar reportes de conciliación y cierre en CSV/Excel'),

  -- Reportes, Clientes y Auditoría
  ('Reportes', 'exportar', 'Reportes - exportar', 'Descargar informes consolidados del negocio'),
  ('Clientes', 'exportar', 'Clientes - exportar', 'Exportar base de datos de clientes'),
  ('Auditoria', 'exportar', 'Auditoria - exportar', 'Exportar registros de la bitácora de seguridad')
ON CONFLICT (module, action) WHERE module IS NOT NULL AND action IS NOT NULL
DO UPDATE SET description = EXCLUDED.description;

-- 2. Asegurar que Administrador y Super Administrador tengan TODOS los permisos
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name IN ('Super Administrador', 'Administrador')
ON CONFLICT DO NOTHING;

COMMIT;
