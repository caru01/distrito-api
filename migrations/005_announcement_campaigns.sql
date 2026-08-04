ALTER TABLE pedidos_app_announcements
  ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cta_label VARCHAR(80) NOT NULL DEFAULT 'Continuar',
  ADD COLUMN IF NOT EXISTS cta_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS display_frequency VARCHAR(20) NOT NULL DEFAULT 'session';

ALTER TABLE pedidos_app_announcements
  DROP CONSTRAINT IF EXISTS pedidos_app_announcements_display_frequency_check;

ALTER TABLE pedidos_app_announcements
  ADD CONSTRAINT pedidos_app_announcements_display_frequency_check
  CHECK (display_frequency IN ('always', 'session', 'daily'));

CREATE INDEX IF NOT EXISTS idx_announcements_active_schedule
  ON pedidos_app_announcements (is_active, starts_at, ends_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchases_purchase_date
  ON pedidos_app_purchases (purchase_date DESC);

ANALYZE pedidos_app_announcements;
ANALYZE pedidos_app_purchases;
