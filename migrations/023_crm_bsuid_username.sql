-- ============================================================
-- 023_crm_bsuid_username.sql
-- Adaptacion para contactos WhatsApp con numero oculto (BSUID)
-- Meta WhatsApp Business envia fromUserId (CO.xxxx) en lugar
-- de telefono cuando el usuario tiene privacidad de numero activada.
-- ============================================================

BEGIN;

-- 1. Hacer normalized_phone nullable
ALTER TABLE pedidos_app_crm_contacts
  ALTER COLUMN normalized_phone DROP NOT NULL;

-- 2. Actualizar el CHECK constraint para que aplique solo cuando no es NULL
ALTER TABLE pedidos_app_crm_contacts
  DROP CONSTRAINT IF EXISTS crm_contacts_phone_e164_check;

ALTER TABLE pedidos_app_crm_contacts
  ADD CONSTRAINT crm_contacts_phone_e164_check
  CHECK (normalized_phone IS NULL OR normalized_phone ~ '^\+[1-9][0-9]{7,14}$');

-- 3. Agregar columna bsuid (Business-Scoped User ID de Meta WhatsApp)
ALTER TABLE pedidos_app_crm_contacts
  ADD COLUMN IF NOT EXISTS bsuid VARCHAR(128);

-- 4. Indice UNIQUE parcial para bsuid (NULLs no compiten entre si)
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_contacts_bsuid
  ON pedidos_app_crm_contacts (bsuid)
  WHERE bsuid IS NOT NULL;

-- 5. Agregar columna username (ej: Ricaurte_blanco) -- solo display/busqueda
ALTER TABLE pedidos_app_crm_contacts
  ADD COLUMN IF NOT EXISTS username VARCHAR(128);

-- 6. Garantizar que todo contacto tenga al menos un identificador
ALTER TABLE pedidos_app_crm_contacts
  ADD CONSTRAINT crm_contacts_identity_check
  CHECK (normalized_phone IS NOT NULL OR bsuid IS NOT NULL);

-- 7. Indice GIN para busqueda por username
CREATE INDEX IF NOT EXISTS idx_crm_contacts_username_trgm
  ON pedidos_app_crm_contacts USING gin (username gin_trgm_ops)
  WHERE deleted_at IS NULL AND username IS NOT NULL;

COMMIT;
