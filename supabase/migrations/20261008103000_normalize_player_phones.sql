-- Canonical E.164 representation at the persistence boundary. This applies
-- to UI, webhook, import script, Edge Function and service-role writes.
CREATE OR REPLACE FUNCTION public.normalize_brazilian_phone(p_raw text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_digits text; v_local text;
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN RETURN NULL; END IF;
  v_digits := regexp_replace(p_raw, '[^0-9]', '', 'g');
  v_local := CASE WHEN left(v_digits,2)='55' AND length(v_digits) IN (12,13)
    THEN substr(v_digits,3) ELSE v_digits END;
  IF v_local !~ '^[1-9]{2}(9[0-9]{8}|[2-8][0-9]{7})$' THEN
    RETURN NULL;
  END IF;
  RETURN '+55' || v_local;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_player_phone_before_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.telefone := public.normalize_brazilian_phone(NEW.telefone);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_players_normalize_phone ON public.players;
CREATE TRIGGER trg_players_normalize_phone
BEFORE INSERT OR UPDATE OF telefone ON public.players
FOR EACH ROW EXECUTE FUNCTION public.normalize_player_phone_before_write();

-- Preserve malformed historical values for explicit review; migrate every
-- value that is safely recognizable without guessing.
UPDATE public.players
SET telefone = public.normalize_brazilian_phone(telefone)
WHERE telefone IS NOT NULL
  AND CASE WHEN left(regexp_replace(telefone,'[^0-9]','','g'),2)='55'
      AND length(regexp_replace(telefone,'[^0-9]','','g')) IN (12,13)
    THEN substr(regexp_replace(telefone,'[^0-9]','','g'),3)
    ELSE regexp_replace(telefone,'[^0-9]','','g') END
    ~ '^[1-9]{2}(9[0-9]{8}|[2-8][0-9]{7})$';

REVOKE ALL ON FUNCTION public.normalize_brazilian_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_brazilian_phone(text) TO service_role;
