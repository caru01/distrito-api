-- Rollback Migración 046: Distric House Print Agent
-- No afecta pedidos, pagos ni inventario.

DROP TABLE IF EXISTS pedidos_app_print_job_events CASCADE;
DROP TABLE IF EXISTS pedidos_app_print_job_targets CASCADE;
DROP TABLE IF EXISTS pedidos_app_print_jobs CASCADE;
DROP TABLE IF EXISTS pedidos_app_print_agents CASCADE;

ALTER TABLE pedidos_app_settings DROP CONSTRAINT IF EXISTS chk_settings_printer_mode;
ALTER TABLE pedidos_app_settings DROP CONSTRAINT IF EXISTS chk_settings_printer_paper_width;
ALTER TABLE pedidos_app_settings DROP CONSTRAINT IF EXISTS chk_settings_print_job_expiry;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS printer_mode;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS printer_primary_name;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS printer_secondary_name;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS printer_paper_width;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS print_agent_id;
ALTER TABLE pedidos_app_settings DROP COLUMN IF EXISTS print_job_expiry_minutes;

DELETE FROM pedidos_app_role_permissions
WHERE permission_id IN (SELECT id FROM pedidos_app_permissions WHERE module = 'Impresoras');
DELETE FROM pedidos_app_permissions WHERE module = 'Impresoras';
