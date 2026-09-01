-- ============================================================
-- 024_orders_bsuid_support.sql
-- Permite pedidos manuales asociados a contactos BSUID/username
-- sin requerir número telefónico y evitando duplicaciones mediante fusión.
-- ============================================================

BEGIN;

-- ============================================================
-- Función para fusionar contactos CRM de manera segura
-- Traslada BSUID, username y el historial relacional (FKs)
-- ============================================================
CREATE OR REPLACE FUNCTION pedidos_app_crm_merge_contacts(source_id BIGINT, target_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  src_record RECORD;
  tgt_record RECORD;
BEGIN
  IF source_id = target_id THEN RETURN; END IF;

  SELECT * INTO src_record FROM pedidos_app_crm_contacts WHERE id = source_id FOR UPDATE;
  SELECT * INTO tgt_record FROM pedidos_app_crm_contacts WHERE id = target_id FOR UPDATE;

  IF src_record IS NULL OR tgt_record IS NULL THEN RETURN; END IF;

  -- 1. Trasladar BSUID y Username (Si el target no tiene)
  IF tgt_record.bsuid IS NULL AND src_record.bsuid IS NOT NULL THEN
    -- Liberar BSUID del origen con un valor dummy para no violar crm_contacts_identity_check
    UPDATE pedidos_app_crm_contacts SET bsuid = 'MERGED_' || source_id WHERE id = source_id;
    UPDATE pedidos_app_crm_contacts SET bsuid = src_record.bsuid WHERE id = target_id;
  END IF;

  IF tgt_record.username IS NULL AND src_record.username IS NOT NULL THEN
    -- Liberar username del origen
    UPDATE pedidos_app_crm_contacts SET username = 'merged_' || source_id WHERE id = source_id;
    UPDATE pedidos_app_crm_contacts SET username = src_record.username WHERE id = target_id;
  END IF;

  -- 2. Migrar claves foráneas críticas (Historial)
  -- Al actualizar pedidos, el trigger trg_crm_order_after recalcula automáticamente 
  -- las métricas (orders_count, total_spent) para ambos contactos.
  UPDATE pedidos_app_orders SET crm_contact_id = target_id WHERE crm_contact_id = source_id;
  UPDATE pedidos_app_crm_conversations SET contact_id = target_id WHERE contact_id = source_id;
  UPDATE pedidos_app_crm_messages SET contact_id = target_id WHERE contact_id = source_id;
  UPDATE pedidos_app_crm_activities SET contact_id = target_id WHERE contact_id = source_id;
  UPDATE pedidos_app_crm_notes SET contact_id = target_id WHERE contact_id = source_id;
  UPDATE pedidos_app_crm_automation_runs SET contact_id = target_id WHERE contact_id = source_id;
  UPDATE pedidos_app_crm_attributions SET contact_id = target_id WHERE contact_id = source_id;
  
  -- Tablas de relación (Manejo de duplicados atrapando unique_violation y purgando)
  BEGIN UPDATE pedidos_app_crm_contact_tags SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_contact_tags WHERE contact_id = source_id; END;
  BEGIN UPDATE pedidos_app_crm_contact_customers SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_contact_customers WHERE contact_id = source_id; END;
  BEGIN UPDATE pedidos_app_crm_consents SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_consents WHERE contact_id = source_id; END;
  BEGIN UPDATE pedidos_app_crm_contact_interests SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_contact_interests WHERE contact_id = source_id; END;
  BEGIN UPDATE pedidos_app_crm_segment_members SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_segment_members WHERE contact_id = source_id; END;
  BEGIN UPDATE pedidos_app_crm_campaign_recipients SET contact_id = target_id WHERE contact_id = source_id; EXCEPTION WHEN unique_violation THEN DELETE FROM pedidos_app_crm_campaign_recipients WHERE contact_id = source_id; END;

  -- 3. Soft Delete del origen
  UPDATE pedidos_app_crm_contacts SET 
    deleted_at = NOW(), 
    status = 'INACTIVO',
    normalized_phone = NULL
  WHERE id = source_id;
END;
$$;


-- ============================================================
-- Trigger para asociar el pedido al contacto correcto
-- ============================================================
CREATE OR REPLACE FUNCTION pedidos_app_crm_sync_order_before()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  normalized TEXT := pedidos_app_normalize_phone_e164(NEW.customer_phone);
  existing_phone_contact_id BIGINT;
BEGIN
  NEW.customer_phone_e164 := normalized;
  
  -- Verificar si el teléfono ya pertenece a un contacto existente activo
  IF normalized IS NOT NULL THEN
    SELECT id INTO existing_phone_contact_id 
    FROM pedidos_app_crm_contacts 
    WHERE normalized_phone = normalized AND deleted_at IS NULL
    LIMIT 1;
  END IF;

  -- Caso 1: No hay teléfono (ej. Contacto puramente BSUID)
  IF normalized IS NULL THEN
    IF NEW.crm_contact_id IS NOT NULL THEN
      UPDATE pedidos_app_crm_contacts SET
        display_name = COALESCE(NULLIF(display_name, ''), NULLIF(NEW.customer_name, '')),
        address = COALESCE(NULLIF(address, ''), NULLIF(NEW.address, '')),
        barrio = COALESCE(NULLIF(barrio, ''), NULLIF(NEW.barrio, '')),
        updated_at = NOW()
      WHERE id = NEW.crm_contact_id;
      RETURN NEW;
    END IF;
    NEW.crm_contact_id := NULL;
    RETURN NEW;
  END IF;

  -- Caso 2: Hay teléfono y el empleado seleccionó un contacto CRM (Ej. BSUID)
  IF NEW.crm_contact_id IS NOT NULL THEN
    -- Sub-Caso 2A: Conflicto de Identidad (El teléfono pertenece a OTRO contacto)
    IF existing_phone_contact_id IS NOT NULL AND existing_phone_contact_id <> NEW.crm_contact_id THEN
      -- Priorizamos el teléfono (target) y fusionamos el historial del BSUID (source) hacia él.
      PERFORM pedidos_app_crm_merge_contacts(NEW.crm_contact_id, existing_phone_contact_id);
      NEW.crm_contact_id := existing_phone_contact_id;
      
      -- Enriquecemos el contacto ganador
      UPDATE pedidos_app_crm_contacts SET
        display_name = COALESCE(NULLIF(display_name, ''), NULLIF(NEW.customer_name, '')),
        address = COALESCE(NULLIF(address, ''), NULLIF(NEW.address, '')),
        barrio = COALESCE(NULLIF(barrio, ''), NULLIF(NEW.barrio, '')),
        updated_at = NOW()
      WHERE id = NEW.crm_contact_id;
      RETURN NEW;
    END IF;

    -- Sub-Caso 2B: El teléfono es nuevo, no hay conflicto (Actualizamos nuestro BSUID)
    UPDATE pedidos_app_crm_contacts SET
      normalized_phone = normalized,
      display_name = COALESCE(NULLIF(display_name, ''), NULLIF(NEW.customer_name, '')),
      address = COALESCE(NULLIF(address, ''), NULLIF(NEW.address, '')),
      barrio = COALESCE(NULLIF(barrio, ''), NULLIF(NEW.barrio, '')),
      updated_at = NOW()
    WHERE id = NEW.crm_contact_id;
      
    -- Si acabamos de ponerle teléfono y estaba 'NUEVO_CONTACTO' o sin marketing
    -- status se recalcula por el order_after trigger.
    RETURN NEW;
  END IF;

  -- Caso 3: Flujo estándar basado en teléfono (Sin BSUID previo seleccionado)
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
BEFORE INSERT OR UPDATE OF customer_name, customer_phone, address, barrio, source, utm_source, utm_medium, utm_campaign, utm_content, crm_contact_id
ON pedidos_app_orders FOR EACH ROW EXECUTE FUNCTION pedidos_app_crm_sync_order_before();

COMMIT;
