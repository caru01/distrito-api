-- Fundación CRM: identidad canónica, consentimiento, conversaciones y métricas.
-- El backfill nunca concede consentimiento de marketing.

CREATE OR REPLACE FUNCTION pedidos_app_normalize_phone_e164(raw_phone TEXT, default_country_code TEXT DEFAULT '57')
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT := regexp_replace(COALESCE(raw_phone, ''), '\D', '', 'g');
BEGIN
  IF digits LIKE '00%' THEN digits := substring(digits FROM 3); END IF;
  IF digits = '' THEN RETURN NULL; END IF;
  IF default_country_code = '57' AND length(digits) = 10 AND (digits LIKE '3%' OR digits LIKE '60%') THEN
    RETURN '+57' || digits;
  END IF;
  IF default_country_code = '57' AND length(digits) = 12 AND digits LIKE '57%'
     AND (substring(digits FROM 3) LIKE '3%' OR substring(digits FROM 3) LIKE '60%') THEN
    RETURN '+' || digits;
  END IF;
  IF left(COALESCE(raw_phone, ''), 1) = '+' AND length(digits) BETWEEN 8 AND 15 THEN
    RETURN '+' || digits;
  END IF;
  IF digits LIKE default_country_code || '%' AND length(digits) BETWEEN length(default_country_code) + 7 AND 15 THEN
    RETURN '+' || digits;
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS crm_inactive_days SMALLINT NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS crm_frequent_orders SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS crm_vip_orders SMALLINT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS crm_vip_spend BIGINT NOT NULL DEFAULT 500000,
  ADD COLUMN IF NOT EXISTS crm_attribution_days SMALLINT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS crm_campaign_frequency_days SMALLINT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS crm_campaign_start_time TIME NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS crm_campaign_end_time TIME NOT NULL DEFAULT '20:00';

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_crm_inactive_days_check,
  DROP CONSTRAINT IF EXISTS settings_crm_frequent_orders_check,
  DROP CONSTRAINT IF EXISTS settings_crm_vip_orders_check,
  DROP CONSTRAINT IF EXISTS settings_crm_vip_spend_check,
  DROP CONSTRAINT IF EXISTS settings_crm_attribution_days_check,
  DROP CONSTRAINT IF EXISTS settings_crm_campaign_frequency_days_check;

ALTER TABLE pedidos_app_settings
  ADD CONSTRAINT settings_crm_inactive_days_check CHECK (crm_inactive_days BETWEEN 1 AND 3650),
  ADD CONSTRAINT settings_crm_frequent_orders_check CHECK (crm_frequent_orders BETWEEN 2 AND 1000),
  ADD CONSTRAINT settings_crm_vip_orders_check CHECK (crm_vip_orders BETWEEN 2 AND 10000),
  ADD CONSTRAINT settings_crm_vip_spend_check CHECK (crm_vip_spend >= 0),
  ADD CONSTRAINT settings_crm_attribution_days_check CHECK (crm_attribution_days BETWEEN 1 AND 90),
  ADD CONSTRAINT settings_crm_campaign_frequency_days_check CHECK (crm_campaign_frequency_days BETWEEN 0 AND 365);

ALTER TABLE pedidos_app_customers
  ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(16),
  ADD COLUMN IF NOT EXISTS source VARCHAR(40),
  ADD COLUMN IF NOT EXISTS utm_source VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(160),
  ADD COLUMN IF NOT EXISTS utm_content VARCHAR(160);

UPDATE pedidos_app_customers
SET phone_e164 = pedidos_app_normalize_phone_e164(phone)
WHERE phone_e164 IS DISTINCT FROM pedidos_app_normalize_phone_e164(phone);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_contacts (
  id BIGSERIAL PRIMARY KEY,
  primary_customer_id INTEGER REFERENCES pedidos_app_customers(id) ON DELETE SET NULL,
  normalized_phone VARCHAR(16) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  email VARCHAR(255),
  address TEXT,
  barrio VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'NUEVO_CONTACTO',
  source VARCHAR(40) NOT NULL DEFAULT 'OTRO',
  assigned_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  first_contact_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  first_purchase_at TIMESTAMPTZ,
  last_purchase_at TIMESTAMPTZ,
  last_order_at TIMESTAMPTZ,
  orders_count INTEGER NOT NULL DEFAULT 0,
  cancelled_orders INTEGER NOT NULL DEFAULT 0,
  total_spent BIGINT NOT NULL DEFAULT 0,
  average_ticket BIGINT NOT NULL DEFAULT 0,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  no_contact BOOLEAN NOT NULL DEFAULT FALSE,
  opt_out_reason TEXT,
  utm_source VARCHAR(120),
  utm_medium VARCHAR(120),
  utm_campaign VARCHAR(160),
  utm_content VARCHAR(160),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_contacts_phone_e164_check CHECK (normalized_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT crm_contacts_status_check CHECK (status IN (
    'NUEVO_CONTACTO','PROSPECTO','CLIENTE_NUEVO','CLIENTE_RECURRENTE',
    'CLIENTE_FRECUENTE','VIP','INACTIVO','RECUPERADO','NO_CONTACTAR'
  )),
  CONSTRAINT crm_contacts_metrics_check CHECK (
    orders_count >= 0 AND cancelled_orders >= 0 AND total_spent >= 0 AND average_ticket >= 0
  )
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_contact_customers (
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL UNIQUE REFERENCES pedidos_app_customers(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, customer_id)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_consents (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP',
  consent_type VARCHAR(30) NOT NULL DEFAULT 'MARKETING',
  granted BOOLEAN NOT NULL,
  source VARCHAR(60) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_consents_channel_check CHECK (channel IN ('WHATSAPP','EMAIL','SMS','PUSH')),
  CONSTRAINT crm_consents_type_check CHECK (consent_type IN ('MARKETING','SERVICE'))
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_tags (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#D4A017',
  description VARCHAR(300),
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_tags_color_check CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_tags_name_unique ON pedidos_app_crm_tags (LOWER(name));

CREATE TABLE IF NOT EXISTS pedidos_app_crm_contact_tags (
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES pedidos_app_crm_tags(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_contact_interests (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  product_id UUID REFERENCES pedidos_app_products(id) ON DELETE SET NULL,
  category VARCHAR(120),
  label VARCHAR(160) NOT NULL,
  score NUMERIC(6,3) NOT NULL DEFAULT 1,
  source VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_interests_score_check CHECK (score >= 0)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_notes (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT crm_notes_body_check CHECK (char_length(body) BETWEEN 1 AND 5000)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_conversations (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP',
  provider_account_id VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  assigned_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  subject VARCHAR(255),
  unread_count INTEGER NOT NULL DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_conversations_channel_check CHECK (channel IN ('WHATSAPP','PHONE','EMAIL','WEB','MANUAL')),
  CONSTRAINT crm_conversations_status_check CHECK (status IN ('OPEN','PENDING','CLOSED')),
  CONSTRAINT crm_conversations_unread_check CHECK (unread_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_conversations_one_active
  ON pedidos_app_crm_conversations (contact_id, channel)
  WHERE status IN ('OPEN','PENDING');

CREATE TABLE IF NOT EXISTS pedidos_app_crm_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES pedidos_app_crm_conversations(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  provider_message_id VARCHAR(180),
  context_provider_message_id VARCHAR(180),
  direction VARCHAR(10) NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text',
  text_body TEXT,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  error_code VARCHAR(80),
  error_message VARCHAR(500),
  sent_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_messages_direction_check CHECK (direction IN ('INBOUND','OUTBOUND')),
  CONSTRAINT crm_messages_type_check CHECK (message_type IN ('text','image','audio','video','document','location','interactive','template','unknown')),
  CONSTRAINT crm_messages_status_check CHECK (status IN ('RECEIVED','QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','CANCELLED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_messages_provider_unique
  ON pedidos_app_crm_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pedidos_app_crm_activities (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  activity_type VARCHAR(60) NOT NULL,
  entity_type VARCHAR(60),
  entity_id VARCHAR(120),
  actor_user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  summary VARCHAR(500) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP',
  event_key VARCHAR(220) NOT NULL UNIQUE,
  event_type VARCHAR(60) NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  error_code VARCHAR(80),
  error_message VARCHAR(500),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT crm_webhook_status_check CHECK (processing_status IN ('RECEIVED','PROCESSED','IGNORED','FAILED'))
);

ALTER TABLE pedidos_app_orders
  ADD COLUMN IF NOT EXISTS customer_phone_e164 VARCHAR(16),
  ADD COLUMN IF NOT EXISTS crm_contact_id BIGINT REFERENCES pedidos_app_crm_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS utm_source VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(120),
  ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(160),
  ADD COLUMN IF NOT EXISTS utm_content VARCHAR(160);

WITH candidates AS (
  SELECT c.id AS customer_id, c.phone_e164 AS normalized_phone, c.name AS display_name,
         c.email, c.address, c.barrio, COALESCE(NULLIF(UPPER(c.source), ''), 'OTRO') AS source,
         c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content,
         COALESCE(c.updated_at, c.created_at, NOW()) AS observed_at
  FROM pedidos_app_customers c
  WHERE c.phone_e164 IS NOT NULL
  UNION ALL
  SELECT NULL::INTEGER, pedidos_app_normalize_phone_e164(o.customer_phone), o.customer_name,
         NULL::VARCHAR, o.address, o.barrio,
         CASE UPPER(COALESCE(o.source, '')) WHEN 'WHATSAPP' THEN 'WHATSAPP' WHEN 'WEB' THEN 'TIENDA_DIRECTA'
              WHEN 'PRESENCIAL' THEN 'MANUAL' ELSE 'OTRO' END,
         o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content,
         COALESCE(o.updated_at, o.created_at, NOW())
  FROM pedidos_app_orders o
  WHERE pedidos_app_normalize_phone_e164(o.customer_phone) IS NOT NULL
), grouped AS (
  SELECT normalized_phone,
         (array_agg(customer_id ORDER BY (customer_id IS NULL), observed_at DESC))[1] AS primary_customer_id,
         (array_agg(display_name ORDER BY observed_at DESC) FILTER (WHERE display_name IS NOT NULL AND display_name <> ''))[1] AS display_name,
         (array_agg(email ORDER BY observed_at DESC) FILTER (WHERE email IS NOT NULL AND email <> ''))[1] AS email,
         (array_agg(address ORDER BY observed_at DESC) FILTER (WHERE address IS NOT NULL AND address <> ''))[1] AS address,
         (array_agg(barrio ORDER BY observed_at DESC) FILTER (WHERE barrio IS NOT NULL AND barrio <> ''))[1] AS barrio,
         (array_agg(source ORDER BY observed_at ASC))[1] AS source,
         (array_agg(utm_source ORDER BY observed_at DESC) FILTER (WHERE utm_source IS NOT NULL))[1] AS utm_source,
         (array_agg(utm_medium ORDER BY observed_at DESC) FILTER (WHERE utm_medium IS NOT NULL))[1] AS utm_medium,
         (array_agg(utm_campaign ORDER BY observed_at DESC) FILTER (WHERE utm_campaign IS NOT NULL))[1] AS utm_campaign,
         (array_agg(utm_content ORDER BY observed_at DESC) FILTER (WHERE utm_content IS NOT NULL))[1] AS utm_content,
         MIN(observed_at) AS created_at
  FROM candidates GROUP BY normalized_phone
)
INSERT INTO pedidos_app_crm_contacts
  (primary_customer_id, normalized_phone, display_name, email, address, barrio, source,
   utm_source, utm_medium, utm_campaign, utm_content, created_at, updated_at)
SELECT primary_customer_id, normalized_phone, display_name, email, address, barrio, source,
       utm_source, utm_medium, utm_campaign, utm_content, created_at, NOW()
FROM grouped
ON CONFLICT (normalized_phone) DO UPDATE SET
  primary_customer_id=COALESCE(pedidos_app_crm_contacts.primary_customer_id, EXCLUDED.primary_customer_id),
  display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), pedidos_app_crm_contacts.display_name),
  email=COALESCE(NULLIF(EXCLUDED.email, ''), pedidos_app_crm_contacts.email),
  address=COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_crm_contacts.address),
  barrio=COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_crm_contacts.barrio),
  updated_at=NOW();

INSERT INTO pedidos_app_crm_contact_customers (contact_id, customer_id)
SELECT contact.id, customer.id
FROM pedidos_app_customers customer
JOIN pedidos_app_crm_contacts contact ON contact.normalized_phone=customer.phone_e164
ON CONFLICT (customer_id) DO UPDATE SET contact_id=EXCLUDED.contact_id;

UPDATE pedidos_app_orders order_data
SET customer_phone_e164=pedidos_app_normalize_phone_e164(order_data.customer_phone),
    crm_contact_id=contact.id
FROM pedidos_app_crm_contacts contact
WHERE contact.normalized_phone=pedidos_app_normalize_phone_e164(order_data.customer_phone)
  AND (order_data.customer_phone_e164 IS DISTINCT FROM contact.normalized_phone OR order_data.crm_contact_id IS DISTINCT FROM contact.id);

CREATE OR REPLACE FUNCTION pedidos_app_crm_status_for(
  current_status TEXT, completed_orders INTEGER, total_spent_value BIGINT,
  last_purchase TIMESTAMPTZ, first_contact TIMESTAMPTZ,
  opted_out BOOLEAN, no_contact_value BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  settings_row RECORD;
BEGIN
  IF opted_out OR no_contact_value THEN RETURN 'NO_CONTACTAR'; END IF;
  SELECT crm_inactive_days, crm_frequent_orders, crm_vip_orders, crm_vip_spend
  INTO settings_row FROM pedidos_app_settings WHERE id=1;
  IF COALESCE(completed_orders, 0)=0 THEN
    RETURN CASE WHEN first_contact IS NULL THEN 'NUEVO_CONTACTO' ELSE 'PROSPECTO' END;
  END IF;
  IF last_purchase < NOW() - make_interval(days => COALESCE(settings_row.crm_inactive_days, 90)) THEN RETURN 'INACTIVO'; END IF;
  IF current_status='INACTIVO' THEN RETURN 'RECUPERADO'; END IF;
  IF completed_orders >= COALESCE(settings_row.crm_vip_orders, 10)
     OR total_spent_value >= COALESCE(settings_row.crm_vip_spend, 500000) THEN RETURN 'VIP'; END IF;
  IF completed_orders >= COALESCE(settings_row.crm_frequent_orders, 5) THEN RETURN 'CLIENTE_FRECUENTE'; END IF;
  IF completed_orders >= 2 THEN RETURN 'CLIENTE_RECURRENTE'; END IF;
  RETURN 'CLIENTE_NUEVO';
END;
$$;

CREATE OR REPLACE FUNCTION pedidos_app_crm_refresh_contact(target_contact_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  WITH metrics AS (
    SELECT COUNT(*) FILTER (WHERE status IN ('Entregado','Completado'))::INTEGER AS orders_count,
           COUNT(*) FILTER (WHERE status='Cancelado')::INTEGER AS cancelled_orders,
           COALESCE(SUM(total) FILTER (WHERE status IN ('Entregado','Completado')),0)::BIGINT AS total_spent,
           COALESCE(AVG(total) FILTER (WHERE status IN ('Entregado','Completado')),0)::BIGINT AS average_ticket,
           MIN(COALESCE(delivered_at, completed_at, created_at)) FILTER (WHERE status IN ('Entregado','Completado')) AS first_purchase_at,
           MAX(COALESCE(delivered_at, completed_at, created_at)) FILTER (WHERE status IN ('Entregado','Completado')) AS last_purchase_at,
           MAX(created_at) AS last_order_at
    FROM pedidos_app_orders WHERE crm_contact_id=target_contact_id
  )
  UPDATE pedidos_app_crm_contacts contact
  SET orders_count=metrics.orders_count,
      cancelled_orders=metrics.cancelled_orders,
      total_spent=metrics.total_spent,
      average_ticket=metrics.average_ticket,
      first_purchase_at=metrics.first_purchase_at,
      last_purchase_at=metrics.last_purchase_at,
      last_order_at=metrics.last_order_at,
      status=pedidos_app_crm_status_for(contact.status, metrics.orders_count, metrics.total_spent,
        metrics.last_purchase_at, contact.first_contact_at, contact.marketing_opt_out, contact.no_contact),
      updated_at=NOW()
  FROM metrics WHERE contact.id=target_contact_id;
END;
$$;

CREATE OR REPLACE FUNCTION pedidos_app_crm_normalize_customer_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.phone_e164 := pedidos_app_normalize_phone_e164(NEW.phone);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pedidos_app_crm_sync_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  normalized TEXT := NEW.phone_e164;
  contact_id_value BIGINT;
BEGIN
  IF normalized IS NULL THEN RETURN NEW; END IF;
  INSERT INTO pedidos_app_crm_contacts
    (primary_customer_id, normalized_phone, display_name, email, address, barrio, source,
     utm_source, utm_medium, utm_campaign, utm_content)
  VALUES
    (NEW.id, normalized, NEW.name, NEW.email, NEW.address, NEW.barrio,
     COALESCE(NULLIF(UPPER(NEW.source), ''), 'MANUAL'), NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content)
  ON CONFLICT (normalized_phone) DO UPDATE SET
    primary_customer_id=COALESCE(pedidos_app_crm_contacts.primary_customer_id, EXCLUDED.primary_customer_id),
    display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), pedidos_app_crm_contacts.display_name),
    email=COALESCE(NULLIF(EXCLUDED.email, ''), pedidos_app_crm_contacts.email),
    address=COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_crm_contacts.address),
    barrio=COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_crm_contacts.barrio),
    updated_at=NOW()
  RETURNING id INTO contact_id_value;
  INSERT INTO pedidos_app_crm_contact_customers (contact_id, customer_id)
  VALUES (contact_id_value, NEW.id)
  ON CONFLICT (customer_id) DO UPDATE SET contact_id=EXCLUDED.contact_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_customer_before ON pedidos_app_customers;
CREATE TRIGGER trg_crm_customer_before
BEFORE INSERT OR UPDATE OF phone, name, email, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content
ON pedidos_app_customers FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_normalize_customer_phone();

DROP TRIGGER IF EXISTS trg_crm_customer_after ON pedidos_app_customers;
CREATE TRIGGER trg_crm_customer_after
AFTER INSERT OR UPDATE OF phone, name, email, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content
ON pedidos_app_customers FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_sync_customer();

CREATE OR REPLACE FUNCTION pedidos_app_crm_sync_order_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  normalized TEXT := pedidos_app_normalize_phone_e164(NEW.customer_phone);
BEGIN
  NEW.customer_phone_e164 := normalized;
  IF normalized IS NULL THEN
    NEW.crm_contact_id := NULL;
    RETURN NEW;
  END IF;
  INSERT INTO pedidos_app_crm_contacts
    (normalized_phone, display_name, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content)
  VALUES
    (normalized, NEW.customer_name, NEW.address, NEW.barrio,
     CASE UPPER(COALESCE(NEW.source,'')) WHEN 'WHATSAPP' THEN 'WHATSAPP' WHEN 'WEB' THEN 'TIENDA_DIRECTA'
          WHEN 'PRESENCIAL' THEN 'MANUAL' ELSE 'OTRO' END,
     NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content)
  ON CONFLICT (normalized_phone) DO UPDATE SET
    display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), pedidos_app_crm_contacts.display_name),
    address=COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_crm_contacts.address),
    barrio=COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_crm_contacts.barrio),
    updated_at=NOW()
  RETURNING id INTO NEW.crm_contact_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_order_before ON pedidos_app_orders;
CREATE TRIGGER trg_crm_order_before
BEFORE INSERT OR UPDATE OF customer_name, customer_phone, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content
ON pedidos_app_orders FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_sync_order_before();

CREATE OR REPLACE FUNCTION pedidos_app_crm_order_after()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.crm_contact_id IS NOT NULL AND OLD.crm_contact_id IS DISTINCT FROM NEW.crm_contact_id THEN
    PERFORM pedidos_app_crm_refresh_contact(OLD.crm_contact_id);
  END IF;
  IF NEW.crm_contact_id IS NOT NULL THEN
    PERFORM pedidos_app_crm_refresh_contact(NEW.crm_contact_id);
    IF TG_OP='INSERT' THEN
      INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,summary,metadata,occurred_at)
      VALUES (NEW.crm_contact_id,'ORDER_CREATED','ORDER',NEW.id::TEXT,'Pedido #' || NEW.id || ' creado',
              jsonb_build_object('status',NEW.status,'source',NEW.source,'total',NEW.total),COALESCE(NEW.created_at,NOW()));
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO pedidos_app_crm_activities (contact_id,activity_type,entity_type,entity_id,summary,metadata)
      VALUES (NEW.crm_contact_id,'ORDER_STATUS_CHANGED','ORDER',NEW.id::TEXT,
              'Pedido #' || NEW.id || ': ' || COALESCE(OLD.status,'') || ' → ' || COALESCE(NEW.status,''),
              jsonb_build_object('previousStatus',OLD.status,'status',NEW.status,'total',NEW.total));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_order_after ON pedidos_app_orders;
CREATE TRIGGER trg_crm_order_after
AFTER INSERT OR UPDATE
ON pedidos_app_orders FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_order_after();

-- El sincronizador legado se conserva, pero ahora evita nuevos duplicados por variantes del mismo teléfono.
CREATE OR REPLACE FUNCTION pedidos_app_sync_customer_from_order()
RETURNS TRIGGER AS $$
DECLARE
  normalized TEXT := pedidos_app_normalize_phone_e164(NEW.customer_phone);
  existing_customer_id INTEGER;
  storage_phone TEXT;
BEGIN
  IF normalized IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO existing_customer_id FROM pedidos_app_customers WHERE phone_e164=normalized ORDER BY id LIMIT 1;
  IF existing_customer_id IS NOT NULL THEN
    UPDATE pedidos_app_customers SET
      name=COALESCE(NULLIF(NEW.customer_name,''),name),
      address=COALESCE(NULLIF(NEW.address,''),address),
      barrio=COALESCE(NULLIF(NEW.barrio,''),barrio),
      preferred_delivery_type=COALESCE(NULLIF(NEW.delivery_type,''),preferred_delivery_type),
      preferred_payment_method=COALESCE(NULLIF(NEW.payment_method,''),preferred_payment_method),
      updated_at=NOW()
    WHERE id=existing_customer_id;
    RETURN NEW;
  END IF;
  storage_phone := substring(normalized FROM 2);
  INSERT INTO pedidos_app_customers
    (name,phone,phone_e164,address,barrio,source,preferred_delivery_type,preferred_payment_method,created_at,updated_at)
  VALUES
    (NEW.customer_name,storage_phone,normalized,NEW.address,NEW.barrio,NEW.source,
     NEW.delivery_type,NEW.payment_method,COALESCE(NEW.created_at,NOW()),NOW())
  ON CONFLICT (phone) DO UPDATE SET
    name=COALESCE(NULLIF(EXCLUDED.name,''),pedidos_app_customers.name),
    address=COALESCE(NULLIF(EXCLUDED.address,''),pedidos_app_customers.address),
    barrio=COALESCE(NULLIF(EXCLUDED.barrio,''),pedidos_app_customers.barrio),
    updated_at=NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE contact_row RECORD;
BEGIN
  FOR contact_row IN SELECT id FROM pedidos_app_crm_contacts LOOP
    PERFORM pedidos_app_crm_refresh_contact(contact_row.id);
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_customers_phone_e164 ON pedidos_app_customers (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_crm_contact_created ON pedidos_app_orders (crm_contact_id, created_at DESC) WHERE crm_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone_e164 ON pedidos_app_orders (customer_phone_e164, created_at DESC) WHERE customer_phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status_activity ON pedidos_app_crm_contacts (status, last_contact_at DESC NULLS LAST, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_last_purchase ON pedidos_app_crm_contacts (last_purchase_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_assignee ON pedidos_app_crm_contacts (assigned_user_id, status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_name ON pedidos_app_crm_contacts (LOWER(display_name));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON pedidos_app_crm_contacts (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_consents_contact_time ON pedidos_app_crm_consents (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_inbox ON pedidos_app_crm_conversations (status, last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_assignee ON pedidos_app_crm_conversations (assigned_user_id, status, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_crm_messages_conversation_time ON pedidos_app_crm_messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_messages_contact_time ON pedidos_app_crm_messages (contact_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact_time ON pedidos_app_crm_activities (contact_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_crm_webhook_received ON pedidos_app_crm_webhook_events (received_at DESC);

INSERT INTO pedidos_app_permissions (name,module,action,description)
SELECT 'CRM - ' || permission.action, 'CRM', permission.action, permission.description
FROM (VALUES
  ('ver','Ver dashboard y resumen CRM'),
  ('contactos','Consultar y administrar contactos CRM'),
  ('conversaciones','Consultar conversaciones'),
  ('responder','Responder conversaciones por canales oficiales'),
  ('notas','Crear y editar notas internas'),
  ('segmentos','Administrar segmentos'),
  ('campanas','Consultar campañas'),
  ('campanas_crear','Crear y editar campañas'),
  ('campanas_enviar','Lanzar o pausar campañas'),
  ('automatizaciones','Administrar automatizaciones'),
  ('reportes','Consultar reportes comerciales'),
  ('configurar','Configurar CRM y WhatsApp'),
  ('exportar','Exportar datos CRM')
) AS permission(action,description)
WHERE NOT EXISTS (
  SELECT 1 FROM pedidos_app_permissions existing WHERE existing.module='CRM' AND existing.action=permission.action
);

INSERT INTO pedidos_app_role_permissions (role_id,permission_id)
SELECT role_data.id, permission.id
FROM pedidos_app_roles role_data
CROSS JOIN pedidos_app_permissions permission
WHERE role_data.name IN ('Super Administrador','Administrador') AND permission.module='CRM'
ON CONFLICT (role_id,permission_id) DO NOTHING;

ANALYZE pedidos_app_customers;
ANALYZE pedidos_app_orders;
ANALYZE pedidos_app_crm_contacts;
ANALYZE pedidos_app_crm_conversations;
ANALYZE pedidos_app_crm_messages;
