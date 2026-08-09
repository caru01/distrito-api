-- Búsqueda CRM por fragmentos sin escanear la tabla completa al crecer el volumen.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_name_trgm
  ON pedidos_app_crm_contacts USING gin (display_name gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone_trgm
  ON pedidos_app_crm_contacts USING gin (normalized_phone gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email_trgm
  ON pedidos_app_crm_contacts USING gin (email gin_trgm_ops)
  WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_barrio_trgm
  ON pedidos_app_crm_contacts USING gin (barrio gin_trgm_ops)
  WHERE deleted_at IS NULL AND barrio IS NOT NULL;

ANALYZE pedidos_app_crm_contacts;
