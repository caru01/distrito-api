-- Alinea la normalización SQL con el dominio Node.js.
-- Un prefijo 00 expresa marcación internacional y no debe recibir nuevamente el país por defecto.

CREATE OR REPLACE FUNCTION pedidos_app_normalize_phone_e164(raw_phone TEXT, default_country_code TEXT DEFAULT '57')
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT := regexp_replace(COALESCE(raw_phone, ''), '\D', '', 'g');
  had_international_prefix BOOLEAN := FALSE;
BEGIN
  IF digits LIKE '00%' THEN
    digits := substring(digits FROM 3);
    had_international_prefix := TRUE;
  END IF;
  IF digits = '' THEN RETURN NULL; END IF;
  IF had_international_prefix AND length(digits) BETWEEN 8 AND 15 THEN
    RETURN '+' || digits;
  END IF;
  IF default_country_code = '57' AND length(digits) = 10 AND (digits LIKE '3%' OR digits LIKE '60%') THEN
    RETURN '+57' || digits;
  END IF;
  IF default_country_code = '57' AND length(digits) = 12 AND digits LIKE '57%'
     AND (substring(digits FROM 3) LIKE '3%' OR substring(digits FROM 3) LIKE '60%') THEN
    RETURN '+' || digits;
  END IF;
  IF left(btrim(COALESCE(raw_phone, '')), 1) = '+' AND length(digits) BETWEEN 8 AND 15 THEN
    RETURN '+' || digits;
  END IF;
  IF digits LIKE default_country_code || '%' AND length(digits) BETWEEN length(default_country_code) + 7 AND 15 THEN
    RETURN '+' || digits;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION pedidos_app_normalize_phone_e164(TEXT, TEXT) IS
  'Normaliza teléfonos a E.164; Colombia es el país por defecto y 00/+ preservan marcación internacional.';
