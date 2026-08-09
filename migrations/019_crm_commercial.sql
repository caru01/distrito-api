-- Segmentación, campañas, cola, automatizaciones y atribución CRM.

CREATE TABLE IF NOT EXISTS pedidos_app_crm_segments (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500),
  segment_type VARCHAR(20) NOT NULL DEFAULT 'DYNAMIC',
  definition JSONB NOT NULL DEFAULT '{"combinator":"AND","rules":[]}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  estimated_count INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_segments_type_check CHECK (segment_type IN ('DYNAMIC','STATIC')),
  CONSTRAINT crm_segments_count_check CHECK (estimated_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_segments_name_unique ON pedidos_app_crm_segments (LOWER(name));

CREATE TABLE IF NOT EXISTS pedidos_app_crm_segment_members (
  segment_id BIGINT NOT NULL REFERENCES pedidos_app_crm_segments(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  added_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_id, contact_id)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_whatsapp_templates (
  id BIGSERIAL PRIMARY KEY,
  provider_template_id VARCHAR(180),
  name VARCHAR(512) NOT NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'es_CO',
  category VARCHAR(30) NOT NULL DEFAULT 'MARKETING',
  status VARCHAR(30) NOT NULL DEFAULT 'LOCAL_DRAFT',
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_quality VARCHAR(30),
  last_synced_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_templates_category_check CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  CONSTRAINT crm_templates_status_check CHECK (status IN ('LOCAL_DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED')),
  UNIQUE (name, language)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_campaigns (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  code VARCHAR(80) NOT NULL UNIQUE,
  objective VARCHAR(40) NOT NULL DEFAULT 'SALES',
  channel VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP',
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  segment_id BIGINT REFERENCES pedidos_app_crm_segments(id) ON DELETE SET NULL,
  template_id BIGINT REFERENCES pedidos_app_crm_whatsapp_templates(id) ON DELETE SET NULL,
  message_preview TEXT,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  attribution_days SMALLINT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  replied_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  converted_count INTEGER NOT NULL DEFAULT 0,
  attributed_revenue BIGINT NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_campaigns_objective_check CHECK (objective IN ('SALES','RECOVERY','LOYALTY','INFORMATION','REACTIVATION')),
  CONSTRAINT crm_campaigns_channel_check CHECK (channel IN ('WHATSAPP')),
  CONSTRAINT crm_campaigns_status_check CHECK (status IN ('DRAFT','SCHEDULED','RUNNING','PAUSED','COMPLETED','CANCELLED','FAILED')),
  CONSTRAINT crm_campaigns_metrics_check CHECK (
    recipient_count >= 0 AND eligible_count >= 0 AND sent_count >= 0 AND delivered_count >= 0
    AND read_count >= 0 AND replied_count >= 0 AND failed_count >= 0
    AND converted_count >= 0 AND attributed_revenue >= 0
  )
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_campaign_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES pedidos_app_crm_campaigns(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES pedidos_app_crm_messages(id) ON DELETE SET NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  exclusion_reason VARCHAR(80),
  rendered_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_message_id VARCHAR(180),
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_campaign_recipients_status_check CHECK (status IN (
    'PENDING','EXCLUDED','QUEUED','SENDING','SENT','DELIVERED','READ','REPLIED','FAILED','CONVERTED','CANCELLED'
  )),
  UNIQUE (campaign_id, contact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_campaign_recipient_provider
  ON pedidos_app_crm_campaign_recipients (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pedidos_app_crm_message_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key VARCHAR(220) NOT NULL UNIQUE,
  message_id BIGINT REFERENCES pedidos_app_crm_messages(id) ON DELETE CASCADE,
  campaign_recipient_id BIGINT REFERENCES pedidos_app_crm_campaign_recipients(id) ON DELETE CASCADE,
  job_type VARCHAR(30) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  priority SMALLINT NOT NULL DEFAULT 50,
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(120),
  last_error_code VARCHAR(80),
  last_error_message VARCHAR(500),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_jobs_type_check CHECK (job_type IN ('TEXT','TEMPLATE')),
  CONSTRAINT crm_jobs_status_check CHECK (status IN ('PENDING','PROCESSING','COMPLETED','RETRY','FAILED','CANCELLED')),
  CONSTRAINT crm_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_automations (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  description VARCHAR(500),
  trigger_type VARCHAR(50) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '{"combinator":"AND","rules":[]}'::jsonb,
  wait_minutes INTEGER NOT NULL DEFAULT 0,
  action_type VARCHAR(40) NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_automations_trigger_check CHECK (trigger_type IN ('CONTACT_CREATED','MESSAGE_RECEIVED','ORDER_COMPLETED','INACTIVITY','NO_PURCHASE_AFTER_CONTACT','BIRTHDAY')),
  CONSTRAINT crm_automations_action_check CHECK (action_type IN ('ENROLL_CAMPAIGN','ADD_TAG','SET_STATUS','ASSIGN_USER')),
  CONSTRAINT crm_automations_wait_check CHECK (wait_minutes BETWEEN 0 AND 525600)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_automation_runs (
  id BIGSERIAL PRIMARY KEY,
  automation_id BIGINT NOT NULL REFERENCES pedidos_app_crm_automations(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  trigger_entity_type VARCHAR(60) NOT NULL,
  trigger_entity_id VARCHAR(120) NOT NULL,
  run_key VARCHAR(240) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_message VARCHAR(500),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_automation_runs_status_check CHECK (status IN ('SCHEDULED','RUNNING','COMPLETED','CANCELLED','FAILED'))
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_attributions (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES pedidos_app_crm_campaigns(id) ON DELETE CASCADE,
  recipient_id BIGINT REFERENCES pedidos_app_crm_campaign_recipients(id) ON DELETE SET NULL,
  contact_id BIGINT NOT NULL REFERENCES pedidos_app_crm_contacts(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES pedidos_app_orders(id) ON DELETE CASCADE,
  attribution_type VARCHAR(20) NOT NULL,
  attributed_amount BIGINT NOT NULL,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT crm_attribution_type_check CHECK (attribution_type IN ('DIRECT','ASSISTED')),
  CONSTRAINT crm_attribution_amount_check CHECK (attributed_amount >= 0)
);

CREATE TABLE IF NOT EXISTS pedidos_app_crm_provider_state (
  provider VARCHAR(30) PRIMARY KEY,
  configured BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_connected BOOLEAN NOT NULL DEFAULT FALSE,
  number_connected BOOLEAN NOT NULL DEFAULT FALSE,
  display_phone_masked VARCHAR(40),
  last_webhook_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO pedidos_app_crm_provider_state (provider) VALUES ('WHATSAPP') ON CONFLICT (provider) DO NOTHING;

CREATE OR REPLACE FUNCTION pedidos_app_crm_refresh_campaign(target_campaign_id BIGINT)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE pedidos_app_crm_campaigns campaign
  SET recipient_count=metrics.recipient_count,
      eligible_count=metrics.eligible_count,
      sent_count=metrics.sent_count,
      delivered_count=metrics.delivered_count,
      read_count=metrics.read_count,
      replied_count=metrics.replied_count,
      failed_count=metrics.failed_count,
      converted_count=metrics.converted_count,
      attributed_revenue=metrics.attributed_revenue,
      updated_at=NOW()
  FROM (
    SELECT COUNT(*)::INTEGER AS recipient_count,
           COUNT(*) FILTER (WHERE status <> 'EXCLUDED')::INTEGER AS eligible_count,
           COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ','REPLIED','CONVERTED'))::INTEGER AS sent_count,
           COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ','REPLIED','CONVERTED'))::INTEGER AS delivered_count,
           COUNT(*) FILTER (WHERE status IN ('READ','REPLIED','CONVERTED'))::INTEGER AS read_count,
           COUNT(*) FILTER (WHERE status IN ('REPLIED','CONVERTED'))::INTEGER AS replied_count,
           COUNT(*) FILTER (WHERE status='FAILED')::INTEGER AS failed_count,
           COUNT(*) FILTER (WHERE status='CONVERTED')::INTEGER AS converted_count,
           COALESCE((SELECT SUM(attributed_amount) FROM pedidos_app_crm_attributions WHERE campaign_id=target_campaign_id),0)::BIGINT AS attributed_revenue
    FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=target_campaign_id
  ) metrics
  WHERE campaign.id=target_campaign_id;
$$;

CREATE OR REPLACE FUNCTION pedidos_app_crm_attribute_completed_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recipient_row RECORD;
  attribution_window SMALLINT;
  attribution_kind TEXT;
BEGIN
  IF NEW.crm_contact_id IS NULL OR NEW.status NOT IN ('Entregado','Completado')
     OR (TG_OP='UPDATE' AND OLD.status IN ('Entregado','Completado')) THEN RETURN NEW; END IF;
  SELECT COALESCE(settings.crm_attribution_days,7) INTO attribution_window FROM pedidos_app_settings settings WHERE settings.id=1;
  SELECT recipient.id, recipient.campaign_id, campaign.code, recipient.sent_at
  INTO recipient_row
  FROM pedidos_app_crm_campaign_recipients recipient
  JOIN pedidos_app_crm_campaigns campaign ON campaign.id=recipient.campaign_id
  WHERE recipient.contact_id=NEW.crm_contact_id
    AND recipient.status IN ('SENT','DELIVERED','READ','REPLIED','CONVERTED')
    AND recipient.sent_at IS NOT NULL
    AND recipient.sent_at <= COALESCE(NEW.delivered_at,NEW.completed_at,NOW())
    AND recipient.sent_at >= COALESCE(NEW.delivered_at,NEW.completed_at,NOW()) - make_interval(days => COALESCE(campaign.attribution_days,attribution_window))
  ORDER BY recipient.sent_at DESC LIMIT 1;
  IF recipient_row.id IS NULL THEN RETURN NEW; END IF;
  attribution_kind := CASE WHEN NEW.utm_campaign IS NOT NULL AND LOWER(NEW.utm_campaign)=LOWER(recipient_row.code) THEN 'DIRECT' ELSE 'ASSISTED' END;
  INSERT INTO pedidos_app_crm_attributions
    (campaign_id,recipient_id,contact_id,order_id,attribution_type,attributed_amount,metadata)
  VALUES
    (recipient_row.campaign_id,recipient_row.id,NEW.crm_contact_id,NEW.id,attribution_kind,COALESCE(NEW.total,0),
     jsonb_build_object('sentAt',recipient_row.sent_at,'orderSource',NEW.source,'utmCampaign',NEW.utm_campaign))
  ON CONFLICT (order_id) DO NOTHING;
  IF FOUND THEN
    UPDATE pedidos_app_crm_campaign_recipients SET status='CONVERTED',converted_at=NOW(),updated_at=NOW() WHERE id=recipient_row.id;
    PERFORM pedidos_app_crm_refresh_campaign(recipient_row.campaign_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_order_attribution ON pedidos_app_orders;
CREATE TRIGGER trg_crm_order_attribution
AFTER INSERT OR UPDATE OF status ON pedidos_app_orders
FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_attribute_completed_order();

CREATE INDEX IF NOT EXISTS idx_crm_segment_members_contact ON pedidos_app_crm_segment_members (contact_id,segment_id);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_status_schedule ON pedidos_app_crm_campaigns (status,scheduled_at,id);
CREATE INDEX IF NOT EXISTS idx_crm_campaign_recipients_queue ON pedidos_app_crm_campaign_recipients (campaign_id,status,id);
CREATE INDEX IF NOT EXISTS idx_crm_campaign_recipients_contact_time ON pedidos_app_crm_campaign_recipients (contact_id,sent_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_crm_message_jobs_ready ON pedidos_app_crm_message_jobs (priority DESC,available_at,id) WHERE status IN ('PENDING','RETRY');
CREATE INDEX IF NOT EXISTS idx_crm_automations_active ON pedidos_app_crm_automations (trigger_type,id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_crm_automation_runs_ready ON pedidos_app_crm_automation_runs (scheduled_at,id) WHERE status='SCHEDULED';
CREATE INDEX IF NOT EXISTS idx_crm_attributions_campaign_time ON pedidos_app_crm_attributions (campaign_id,attributed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_attributions_contact_time ON pedidos_app_crm_attributions (contact_id,attributed_at DESC);

ANALYZE pedidos_app_crm_segments;
ANALYZE pedidos_app_crm_campaigns;
ANALYZE pedidos_app_crm_campaign_recipients;
ANALYZE pedidos_app_crm_message_jobs;
ANALYZE pedidos_app_crm_attributions;
