-- Telefone internacional em players.telefone. Até aqui o trigger passava todo
-- número por normalize_brazilian_phone: o número argentino local "3483451193"
-- (DDI 54) virava "+553483451193", um celular brasileiro de outra pessoa, e
-- os que não pareciam brasileiros viravam NULL. Agora o webhook manda o número
-- com o DDI ("+543483451193") e o trigger mantém um E.164 internacional
-- explícito. Espelha normalizePlayerPhone em src/lib/phone-normalization.ts.
--
-- O envio (SMS/voz, elegibilidade de campanha) continua só para o Brasil: um
-- número +54 não passa em normalize_brazilian_phone e fica inelegível.
CREATE OR REPLACE FUNCTION public.normalize_player_phone(p_raw text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_br text; v_digits text;
BEGIN
  v_br := public.normalize_brazilian_phone(p_raw);
  IF v_br IS NOT NULL THEN RETURN v_br; END IF;
  IF p_raw IS NULL OR left(btrim(p_raw), 1) <> '+' THEN RETURN NULL; END IF;
  v_digits := regexp_replace(p_raw, '[^0-9]', '', 'g');
  IF left(v_digits, 2) = '55' OR v_digits !~ '^[1-9][0-9]{7,14}$' THEN
    RETURN NULL;
  END IF;
  RETURN '+' || v_digits;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_player_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_player_phone(text) TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_player_phone_before_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.telefone := public.normalize_player_phone(NEW.telefone);
  RETURN NEW;
END;
$$;

-- Correção dos já gravados: casas fora do BRL (hoje só a Los Hermanos), a
-- partir do último webhook do player que trouxe DDI estrangeiro.
UPDATE public.players p
SET telefone = '+' || src.e164
FROM (
  SELECT DISTINCT ON (l.tenant_id, l.payload->'user'->>'id')
    l.tenant_id,
    l.payload->'user'->>'id' AS external_id,
    regexp_replace(
      coalesce(
        nullif(l.payload->'user'->>'phone_e164', ''),
        (l.payload->'user'->>'ddi') || (l.payload->'user'->>'phone')
      ),
      '[^0-9]', '', 'g'
    ) AS e164
  FROM public.webhook_logs l
  JOIN public.tenants t ON t.id = l.tenant_id AND t.moeda <> 'BRL'
  WHERE coalesce(l.payload->'user'->>'ddi', '') NOT IN ('', '55')
    AND coalesce(l.payload->'user'->>'phone', '') <> ''
  ORDER BY l.tenant_id, l.payload->'user'->>'id', l.created_at DESC
) src
WHERE p.tenant_id = src.tenant_id
  AND p.player_external_id = src.external_id
  AND src.e164 ~ '^[1-9][0-9]{7,14}$'
  AND p.telefone IS DISTINCT FROM '+' || src.e164;
