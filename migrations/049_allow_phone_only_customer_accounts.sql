-- Migration 049: Allow Phone-Only Customer Accounts & Enforce Unique Phone
-- Reversible: Yes

BEGIN;

-- 1. Relajar restricción NOT NULL en email para permitir registro exclusivamente por teléfono
ALTER TABLE appmobile_customer_accounts ALTER COLUMN email DROP NOT NULL;

-- 2. Eliminar la restricción de unicidad estricta antigua si existe para reemplazarla por índice parcial (ignora NULL y vacíos)
ALTER TABLE appmobile_customer_accounts DROP CONSTRAINT IF EXISTS pedidos_app_customer_accounts_email_key;

-- 3. Crear índice único parcial en email (solo aplica cuando email no es nulo ni vacío)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_email_unique
ON appmobile_customer_accounts (LOWER(email))
WHERE email IS NOT NULL AND email <> '';

-- 4. Asegurar unicidad en teléfono (solo cuando phone no sea nulo ni vacío)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_phone_unique
ON appmobile_customer_accounts (phone)
WHERE phone IS NOT NULL AND phone <> '';

COMMIT;
