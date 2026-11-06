-- Migración 046: Distric House Print Agent (impresión local en 1 o 2 impresoras)
-- Crea la infraestructura para que un agente local en Windows recoja trabajos de impresión
-- mediante conexión saliente HTTPS. No modifica pedidos, pagos ni inventario.
-- Idempotente: puede ejecutarse más de una vez sin efectos secundarios.

-- 1. Configuración de impresión
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS printer_mode TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS printer_primary_name TEXT;
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS printer_secondary_name TEXT;
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS printer_paper_width INTEGER NOT NULL DEFAULT 58;
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS print_agent_id UUID;
ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS print_job_expiry_minutes INTEGER NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_settings_printer_mode') THEN
    ALTER TABLE pedidos_app_settings ADD CONSTRAINT chk_settings_printer_mode
      CHECK (printer_mode IN ('browser', 'agent_single', 'agent_dual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_settings_printer_paper_width') THEN
    ALTER TABLE pedidos_app_settings ADD CONSTRAINT chk_settings_printer_paper_width
      CHECK (printer_paper_width IN (58, 80));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_settings_print_job_expiry') THEN
    ALTER TABLE pedidos_app_settings ADD CONSTRAINT chk_settings_print_job_expiry
      CHECK (print_job_expiry_minutes BETWEEN 1 AND 120);
  END IF;
END $$;

-- 2. Agentes vinculados (el token nunca se guarda en claro, solo su hash SHA-256)
CREATE TABLE IF NOT EXISTS pedidos_app_print_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  last_ip TEXT,
  hostname TEXT,
  agent_version TEXT,
  printers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  printers_reported_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER
);

-- 3. Trabajos de impresión (un documento HTML idéntico para todas sus impresoras destino)
CREATE TABLE IF NOT EXISTS pedidos_app_print_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id INTEGER,
  kind TEXT NOT NULL,
  reprint_of_job_id UUID REFERENCES pedidos_app_print_jobs(id) ON DELETE SET NULL,
  delivery_mode TEXT NOT NULL,
  html TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  paper_width INTEGER NOT NULL DEFAULT 58,
  agent_id UUID REFERENCES pedidos_app_print_agents(id) ON DELETE SET NULL,
  requested_by_user_id INTEGER,
  requested_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_print_jobs_kind CHECK (kind IN ('comanda', 'reprint', 'test')),
  CONSTRAINT chk_print_jobs_delivery_mode CHECK (delivery_mode IN ('agent', 'browser', 'browser_fallback')),
  CONSTRAINT chk_print_jobs_paper_width CHECK (paper_width IN (58, 80)),
  CONSTRAINT chk_print_jobs_html_size CHECK (octet_length(html) <= 512000)
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON pedidos_app_print_jobs(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON pedidos_app_print_jobs(created_at DESC);

-- 4. Destinos: uno por impresora, con estado y resultado independiente
CREATE TABLE IF NOT EXISTS pedidos_app_print_job_targets (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES pedidos_app_print_jobs(id) ON DELETE CASCADE,
  printer_role TEXT NOT NULL,
  printer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  claimed_by_agent_id UUID REFERENCES pedidos_app_print_agents(id) ON DELETE SET NULL,
  lease_until TIMESTAMPTZ,
  windows_job_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  spooled_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT uq_print_job_target_role UNIQUE (job_id, printer_role),
  CONSTRAINT chk_print_targets_role CHECK (printer_role IN ('primary', 'secondary', 'browser')),
  CONSTRAINT chk_print_targets_status CHECK (status IN (
    'pending', 'claimed', 'spooled', 'completed_by_driver', 'failed',
    'unverifiable', 'expired', 'handled_by_browser'
  ))
);

CREATE INDEX IF NOT EXISTS idx_print_targets_claimable
  ON pedidos_app_print_job_targets(status, lease_until)
  WHERE status IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS idx_print_targets_job ON pedidos_app_print_job_targets(job_id);

-- 5. Bitácora individual por impresora (errores, transiciones, reimpresiones)
CREATE TABLE IF NOT EXISTS pedidos_app_print_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES pedidos_app_print_jobs(id) ON DELETE CASCADE,
  target_id BIGINT REFERENCES pedidos_app_print_job_targets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status_from TEXT,
  status_to TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_print_events_actor CHECK (actor_type IN ('user', 'agent', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_print_events_job ON pedidos_app_print_job_events(job_id, created_at);

-- 6. Permiso para vincular/revocar agentes y configurar impresoras
INSERT INTO pedidos_app_permissions (name, module, action, description)
SELECT v.name, v.module, v.action, v.description
FROM (VALUES
  ('Impresoras: configurar', 'Impresoras', 'configurar', 'Vincular el Print Agent, elegir impresoras y modo de impresión')
) AS v(name, module, action, description)
WHERE NOT EXISTS (
  SELECT 1 FROM pedidos_app_permissions p WHERE p.module = v.module AND p.action = v.action
);
