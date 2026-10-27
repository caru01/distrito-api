-- Migración 045: Estado de Finalización e Historial en Conversaciones de Bony
-- Permite distinguir entre conversaciones activas ('ACTIVE') y finalizadas ('COMPLETED'),
-- registrando la fecha exacta de finalización ('completed_at').

ALTER TABLE pedidos_app_ai_conversations 
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_pedidos_app_ai_conversations_status'
  ) THEN
    ALTER TABLE pedidos_app_ai_conversations 
      ADD CONSTRAINT chk_pedidos_app_ai_conversations_status 
      CHECK (status IN ('ACTIVE', 'COMPLETED'));
  END IF;
END $$;

ALTER TABLE pedidos_app_ai_conversations 
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_status 
  ON pedidos_app_ai_conversations(user_id, status) 
  WHERE deleted_at IS NULL;
