-- Recupera la fuente real de adquisición desde el primer pedido conocido y la
-- mantiene para nuevos pedidos cuando el contacto todavía no tiene una fuente útil.

CREATE OR REPLACE FUNCTION pedidos_app_crm_sync_order_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  normalized TEXT := pedidos_app_normalize_phone_e164(NEW.customer_phone);
  normalized_source TEXT := CASE UPPER(COALESCE(NEW.source,''))
    WHEN 'WHATSAPP' THEN 'WHATSAPP'
    WHEN 'WEB' THEN 'TIENDA_DIRECTA'
    WHEN 'PRESENCIAL' THEN 'PRESENCIAL'
    WHEN 'ADMIN' THEN 'MANUAL'
    WHEN 'ADMINISTRACION' THEN 'MANUAL'
    WHEN 'ADMINISTRACIÓN' THEN 'MANUAL'
    ELSE 'OTRO'
  END;
BEGIN
  NEW.customer_phone_e164 := normalized;
  IF normalized IS NULL THEN
    NEW.crm_contact_id := NULL;
    RETURN NEW;
  END IF;
  INSERT INTO pedidos_app_crm_contacts
    (normalized_phone, display_name, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content)
  VALUES
    (normalized, NEW.customer_name, NEW.address, NEW.barrio, normalized_source,
     NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content)
  ON CONFLICT (normalized_phone) DO UPDATE SET
    display_name=COALESCE(NULLIF(EXCLUDED.display_name, ''), pedidos_app_crm_contacts.display_name),
    address=COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_crm_contacts.address),
    barrio=COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_crm_contacts.barrio),
    source=CASE WHEN pedidos_app_crm_contacts.source='OTRO' AND EXCLUDED.source<>'OTRO'
                THEN EXCLUDED.source ELSE pedidos_app_crm_contacts.source END,
    utm_source=COALESCE(pedidos_app_crm_contacts.utm_source,EXCLUDED.utm_source),
    utm_medium=COALESCE(pedidos_app_crm_contacts.utm_medium,EXCLUDED.utm_medium),
    utm_campaign=COALESCE(pedidos_app_crm_contacts.utm_campaign,EXCLUDED.utm_campaign),
    utm_content=COALESCE(pedidos_app_crm_contacts.utm_content,EXCLUDED.utm_content),
    updated_at=NOW()
  RETURNING id INTO NEW.crm_contact_id;
  RETURN NEW;
END;
$$;

WITH first_source AS (
  SELECT DISTINCT ON (order_data.crm_contact_id)
    order_data.crm_contact_id,
    CASE UPPER(COALESCE(order_data.source,''))
      WHEN 'WHATSAPP' THEN 'WHATSAPP'
      WHEN 'WEB' THEN 'TIENDA_DIRECTA'
      WHEN 'PRESENCIAL' THEN 'PRESENCIAL'
      WHEN 'ADMIN' THEN 'MANUAL'
      WHEN 'ADMINISTRACION' THEN 'MANUAL'
      WHEN 'ADMINISTRACIÓN' THEN 'MANUAL'
      ELSE 'OTRO'
    END AS source
  FROM pedidos_app_orders order_data
  WHERE order_data.crm_contact_id IS NOT NULL
  ORDER BY order_data.crm_contact_id,order_data.created_at,order_data.id
)
UPDATE pedidos_app_crm_contacts contact
SET source=first_source.source,updated_at=NOW()
FROM first_source
WHERE contact.id=first_source.crm_contact_id
  AND contact.source='OTRO' AND first_source.source<>'OTRO';

ANALYZE pedidos_app_crm_contacts;
