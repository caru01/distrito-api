-- Personalización central, campañas medibles, CRM y cierres conciliados.

ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS web_logo TEXT,
  ADD COLUMN IF NOT EXISTS web_page_title VARCHAR(120) NOT NULL DEFAULT 'Distrito BG',
  ADD COLUMN IF NOT EXISTS web_hero_title VARCHAR(160) NOT NULL DEFAULT 'Más que comida, una experiencia',
  ADD COLUMN IF NOT EXISTS web_hero_subtitle VARCHAR(300) NOT NULL DEFAULT 'Pedidos preparados al momento.',
  ADD COLUMN IF NOT EXISTS web_font_family VARCHAR(30) NOT NULL DEFAULT 'modern',
  ADD COLUMN IF NOT EXISTS web_card_style VARCHAR(20) NOT NULL DEFAULT 'rounded',
  ADD COLUMN IF NOT EXISTS admin_logo TEXT,
  ADD COLUMN IF NOT EXISTS admin_page_title VARCHAR(120) NOT NULL DEFAULT 'Distrito BG Admin',
  ADD COLUMN IF NOT EXISTS admin_sidebar_title VARCHAR(120) NOT NULL DEFAULT 'Distrito BG',
  ADD COLUMN IF NOT EXISTS admin_font_family VARCHAR(30) NOT NULL DEFAULT 'modern',
  ADD COLUMN IF NOT EXISTS admin_density VARCHAR(20) NOT NULL DEFAULT 'comfortable',
  ADD COLUMN IF NOT EXISTS delivery_logo TEXT,
  ADD COLUMN IF NOT EXISTS delivery_page_title VARCHAR(120) NOT NULL DEFAULT 'Distrito BG Delivery',
  ADD COLUMN IF NOT EXISTS delivery_heading VARCHAR(160) NOT NULL DEFAULT 'Pedidos disponibles',
  ADD COLUMN IF NOT EXISTS delivery_subtitle VARCHAR(300) NOT NULL DEFAULT 'Acepta, recoge y entrega desde un solo lugar.',
  ADD COLUMN IF NOT EXISTS delivery_font_family VARCHAR(30) NOT NULL DEFAULT 'modern',
  ADD COLUMN IF NOT EXISTS delivery_card_style VARCHAR(20) NOT NULL DEFAULT 'rounded',
  ADD COLUMN IF NOT EXISTS delivery_primary_color VARCHAR(7) NOT NULL DEFAULT '#D4A017',
  ADD COLUMN IF NOT EXISTS delivery_background_color VARCHAR(7) NOT NULL DEFAULT '#090909',
  ADD COLUMN IF NOT EXISTS delivery_surface_color VARCHAR(7) NOT NULL DEFAULT '#151515',
  ADD COLUMN IF NOT EXISTS delivery_text_color VARCHAR(7) NOT NULL DEFAULT '#FFFFFF';

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_web_font_family_check,
  DROP CONSTRAINT IF EXISTS settings_admin_font_family_check,
  DROP CONSTRAINT IF EXISTS settings_delivery_font_family_check,
  DROP CONSTRAINT IF EXISTS settings_web_card_style_check,
  DROP CONSTRAINT IF EXISTS settings_delivery_card_style_check,
  DROP CONSTRAINT IF EXISTS settings_admin_density_check;

ALTER TABLE pedidos_app_settings
  ADD CONSTRAINT settings_web_font_family_check CHECK (web_font_family IN ('modern', 'friendly', 'classic', 'system')),
  ADD CONSTRAINT settings_admin_font_family_check CHECK (admin_font_family IN ('modern', 'friendly', 'classic', 'system')),
  ADD CONSTRAINT settings_delivery_font_family_check CHECK (delivery_font_family IN ('modern', 'friendly', 'classic', 'system')),
  ADD CONSTRAINT settings_web_card_style_check CHECK (web_card_style IN ('rounded', 'compact', 'outlined')),
  ADD CONSTRAINT settings_delivery_card_style_check CHECK (delivery_card_style IN ('rounded', 'compact', 'outlined')),
  ADD CONSTRAINT settings_admin_density_check CHECK (admin_density IN ('comfortable', 'compact'));

ALTER TABLE pedidos_app_announcements
  ADD COLUMN IF NOT EXISTS campaign_type VARCHAR(20) NOT NULL DEFAULT 'modal',
  ADD COLUMN IF NOT EXISTS audience VARCHAR(20) NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS views_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE pedidos_app_announcements
  DROP CONSTRAINT IF EXISTS announcements_campaign_type_check,
  DROP CONSTRAINT IF EXISTS announcements_audience_check,
  DROP CONSTRAINT IF EXISTS announcements_priority_check;

ALTER TABLE pedidos_app_announcements
  ADD CONSTRAINT announcements_campaign_type_check CHECK (campaign_type IN ('modal', 'banner')),
  ADD CONSTRAINT announcements_audience_check CHECK (audience IN ('all', 'new', 'returning')),
  ADD CONSTRAINT announcements_priority_check CHECK (priority BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS idx_announcements_campaign_schedule
  ON pedidos_app_announcements (is_active, priority DESC, starts_at, ends_at, updated_at DESC);

ALTER TABLE pedidos_app_customers
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS barrio VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Activo',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS preferred_delivery_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS preferred_payment_method VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;

ALTER TABLE pedidos_app_customers
  DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE pedidos_app_customers
  ADD CONSTRAINT customers_status_check CHECK (status IN ('Activo', 'Inactivo', 'Bloqueado'));

CREATE INDEX IF NOT EXISTS idx_customers_name_search ON pedidos_app_customers (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_customers_status ON pedidos_app_customers (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone_created ON pedidos_app_orders (customer_phone, created_at DESC);

INSERT INTO pedidos_app_customers (name, phone, address, barrio, preferred_delivery_type, preferred_payment_method, created_at, updated_at)
SELECT DISTINCT ON (regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g'))
       customer_name,
       regexp_replace(customer_phone, '\D', '', 'g'),
       address,
       barrio,
       delivery_type,
       payment_method,
       created_at,
       created_at
FROM pedidos_app_orders
WHERE regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g') <> ''
ORDER BY regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g'), created_at DESC
ON CONFLICT (phone) DO UPDATE SET
  name = COALESCE(NULLIF(EXCLUDED.name, ''), pedidos_app_customers.name),
  address = COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_customers.address),
  barrio = COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_customers.barrio),
  preferred_delivery_type = COALESCE(NULLIF(EXCLUDED.preferred_delivery_type, ''), pedidos_app_customers.preferred_delivery_type),
  preferred_payment_method = COALESCE(NULLIF(EXCLUDED.preferred_payment_method, ''), pedidos_app_customers.preferred_payment_method),
  updated_at = GREATEST(pedidos_app_customers.updated_at, EXCLUDED.updated_at);

CREATE OR REPLACE FUNCTION pedidos_app_sync_customer_from_order()
RETURNS TRIGGER AS $$
DECLARE normalized_phone TEXT;
BEGIN
  normalized_phone := regexp_replace(COALESCE(NEW.customer_phone, ''), '\D', '', 'g');
  IF normalized_phone = '' THEN RETURN NEW; END IF;
  INSERT INTO pedidos_app_customers
    (name, phone, address, barrio, preferred_delivery_type, preferred_payment_method, created_at, updated_at)
  VALUES
    (NEW.customer_name, normalized_phone, NEW.address, NEW.barrio, NEW.delivery_type, NEW.payment_method,
     COALESCE(NEW.created_at, NOW()), NOW())
  ON CONFLICT (phone) DO UPDATE SET
    name = COALESCE(NULLIF(EXCLUDED.name, ''), pedidos_app_customers.name),
    address = COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_customers.address),
    barrio = COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_customers.barrio),
    preferred_delivery_type = COALESCE(NULLIF(EXCLUDED.preferred_delivery_type, ''), pedidos_app_customers.preferred_delivery_type),
    preferred_payment_method = COALESCE(NULLIF(EXCLUDED.preferred_payment_method, ''), pedidos_app_customers.preferred_payment_method),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_from_order ON pedidos_app_orders;
CREATE TRIGGER trg_sync_customer_from_order
AFTER INSERT OR UPDATE OF customer_name, customer_phone, address, barrio, delivery_type, payment_method
ON pedidos_app_orders FOR EACH ROW EXECUTE FUNCTION pedidos_app_sync_customer_from_order();

ALTER TABLE pedidos_app_closures
  ADD COLUMN IF NOT EXISTS orders_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_orders INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_expected INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_counted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_difference INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_closures_period_status
  ON pedidos_app_closures (start_date DESC, end_date DESC, status);

ANALYZE pedidos_app_settings;
ANALYZE pedidos_app_announcements;
ANALYZE pedidos_app_customers;
ANALYZE pedidos_app_closures;
