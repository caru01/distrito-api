INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name IN ('Super Administrador', 'Administrador')
ON CONFLICT DO NOTHING;
