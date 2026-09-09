-- BACKUP BEFORE MIGRATION 024 --

CREATE OR REPLACE FUNCTION public.pedidos_app_crm_sync_order_before()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
    RETURN NEW;
  END IF;
  
  IF TG_OP = 'UPDATE' AND NEW.crm_contact_id IS NOT NULL AND OLD.customer_phone IS NULL AND NEW.customer_phone IS NOT NULL THEN
    UPDATE pedidos_app_crm_contacts 
    SET normalized_phone = normalized 
    WHERE id = NEW.crm_contact_id AND normalized_phone IS NULL;
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
$function$
;

CREATE TRIGGER trg_crm_order_before BEFORE INSERT OR UPDATE OF customer_name, customer_phone, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content ON public.pedidos_app_orders FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_sync_order_before();

