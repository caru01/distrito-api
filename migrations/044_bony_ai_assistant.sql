-- Migración 044: Bony AI Assistant (Distric House)
-- Tablas para historial de conversaciones, mensajes, acciones con confirmación y automatizaciones.

CREATE TABLE IF NOT EXISTS pedidos_app_ai_conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL DEFAULT 'Nueva conversación',
  summary TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_id ON pedidos_app_ai_conversations(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_status ON pedidos_app_ai_conversations(user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated_at ON pedidos_app_ai_conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS pedidos_app_ai_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES pedidos_app_ai_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  tokens_estimated INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv_id ON pedidos_app_ai_messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS pedidos_app_ai_actions (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id BIGINT REFERENCES pedidos_app_ai_conversations(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  tool_name VARCHAR(100) NOT NULL,
  action_type VARCHAR(100) NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN ('pending_confirmation', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  result JSONB,
  error_message TEXT,
  confirmed_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  idempotency_key VARCHAR(128) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_actions_status ON pedidos_app_ai_actions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_actions_user ON pedidos_app_ai_actions(user_id);

CREATE TABLE IF NOT EXISTS pedidos_app_ai_automations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  automation_type VARCHAR(50) NOT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
  cron_expression VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_ai_automation_runs (
  id BIGSERIAL PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES pedidos_app_ai_automations(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  result_summary TEXT,
  payload JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_automation_runs_auto_id ON pedidos_app_ai_automation_runs(automation_id, started_at DESC);
