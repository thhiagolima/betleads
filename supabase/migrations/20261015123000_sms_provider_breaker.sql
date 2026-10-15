-- Circuit breaker do provedor SMS (incidente 15/10/2026).
--
-- CONTEXTO
--   Desde 11:38 BRT a Short Brasil responde {"status":101,"statusDetalhe":
--   "Erro de Autenticação"} para todo envio: a rota ficou SEM SALDO (o provedor
--   responde 101 em vez de 505). O app tratava isso como erro do lead:
--   cada item de jornada queimava 3 tentativas e terminava `failed`.
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.provider_circuit_breakers: uma linha por canal (a conta Short
--     Brasil é única e compartilhada por todos os tenants -> estado GLOBAL).
--     closed -> open (backoff 2 min, dobrando até 30 min a cada reabertura)
--     -> half_open (UM envio de prova) -> closed | open.
--   * provider_breaker_report_failure / _report_success / _acquire /
--     _release_probe: transições atômicas (linha travada com FOR UPDATE; a
--     leitura no caminho comum "closed" não trava nada).
--   Só service_role executa. RLS ligada sem políticas (nenhum acesso via API
--   para anon/authenticated).
--
-- COMPATIBILIDADE
--   * Nada existente é alterado: o app em produção ignora a tabela.
--   * O app novo trata a ausência das funções como "breaker fechado"
--     (fail-open) e continua adiando erros de conta sem consumir tentativa.
--   * ORDEM DE DEPLOY: aplicar esta migração ANTES do app novo.
--
-- ROLLBACK
--   DROP FUNCTION public.provider_breaker_report_failure(text, text, text, timestamptz);
--   DROP FUNCTION public.provider_breaker_report_success(text, timestamptz);
--   DROP FUNCTION public.provider_breaker_acquire(text, text, integer);
--   DROP FUNCTION public.provider_breaker_release_probe(text, text);
--   DROP TABLE public.provider_circuit_breakers;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.provider_circuit_breakers (
  channel text PRIMARY KEY CHECK (channel IN ('sms', 'email', 'voice')),
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  -- Categoria curta ('auth' | 'no_balance') e a última mensagem do provedor.
  reason text,
  last_error text,
  -- Início do incidente (primeira abertura desde o último fechamento).
  first_opened_at timestamptz,
  -- Última (re)abertura: envios iniciados antes disso são "antigos".
  opened_at timestamptz,
  -- Aberturas consecutivas sem sucesso (define o backoff).
  open_count integer NOT NULL DEFAULT 0,
  backoff_until timestamptz,
  probe_holder text,
  probe_started_at timestamptz,
  last_alert_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.provider_circuit_breakers IS
  'Circuit breaker global por canal de provedor (conta única para todos os tenants). Escrito só pelas funções provider_breaker_*.';

ALTER TABLE public.provider_circuit_breakers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_circuit_breakers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_circuit_breakers TO service_role;

INSERT INTO public.provider_circuit_breakers (channel) VALUES ('sms')
ON CONFLICT (channel) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Falha de CONTA reportada por um envio (101/505, HTTP 401/402/403).
--   closed                      -> open, open_count = 1, backoff 2 min.
--   half_open, ou open com o
--   backoff vencido, e o envio
--   começou depois da última
--   (re)abertura                -> open, open_count + 1, backoff dobrado
--                                  (2, 4, 8, 16, 30 min).
--   demais (envio antigo / já
--   aberto dentro do backoff)   -> só registra last_error (não dobra).
-- alert_due: verdadeiro uma vez na abertura e depois no máximo a cada 15 min.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provider_breaker_report_failure(
  p_channel text,
  p_reason text,
  p_error text,
  p_send_started_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  state text,
  backoff_until timestamptz,
  first_opened_at timestamptz,
  open_count integer,
  opened boolean,
  alert_due boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  c_base constant interval := interval '2 minutes';
  c_max constant interval := interval '30 minutes';
  c_alert_every constant interval := interval '15 minutes';
  r public.provider_circuit_breakers%ROWTYPE;
  v_count integer;
  v_opened boolean := false;
  v_alert boolean := false;
BEGIN
  INSERT INTO public.provider_circuit_breakers AS b (channel) VALUES (p_channel)
  ON CONFLICT (channel) DO NOTHING;

  SELECT * INTO r FROM public.provider_circuit_breakers b
  WHERE b.channel = p_channel
  FOR UPDATE;

  IF r.state = 'closed' THEN
    v_count := 1;
    v_opened := true;
    UPDATE public.provider_circuit_breakers b
       SET state = 'open', open_count = v_count,
           first_opened_at = now(), opened_at = now(),
           backoff_until = now() + c_base,
           reason = left(p_reason, 64), last_error = left(p_error, 800),
           probe_holder = NULL, probe_started_at = NULL,
           last_alert_at = NULL, updated_at = now()
     WHERE b.channel = p_channel;
  ELSIF (r.state = 'half_open' OR (r.state = 'open' AND coalesce(r.backoff_until, now()) <= now()))
        AND (p_send_started_at IS NULL OR r.opened_at IS NULL OR p_send_started_at >= r.opened_at) THEN
    v_count := r.open_count + 1;
    v_opened := true;
    UPDATE public.provider_circuit_breakers b
       SET state = 'open', open_count = v_count,
           first_opened_at = coalesce(r.first_opened_at, now()), opened_at = now(),
           backoff_until = now() + least(c_max, c_base * power(2, least(v_count - 1, 10))::integer),
           reason = left(p_reason, 64), last_error = left(p_error, 800),
           probe_holder = NULL, probe_started_at = NULL, updated_at = now()
     WHERE b.channel = p_channel;
  ELSE
    UPDATE public.provider_circuit_breakers b
       SET last_error = left(p_error, 800), updated_at = now()
     WHERE b.channel = p_channel;
  END IF;

  SELECT * INTO r FROM public.provider_circuit_breakers b WHERE b.channel = p_channel;
  IF r.state <> 'closed' AND (r.last_alert_at IS NULL OR r.last_alert_at <= now() - c_alert_every) THEN
    v_alert := true;
    UPDATE public.provider_circuit_breakers b SET last_alert_at = now() WHERE b.channel = p_channel;
  END IF;

  RETURN QUERY SELECT r.state, r.backoff_until, r.first_opened_at, r.open_count, v_opened, v_alert;
END;
$$;

-- ---------------------------------------------------------------------------
-- Envio aceito pelo provedor. Fecha o breaker se o envio começou depois da
-- última (re)abertura (um sucesso "antigo" não prova nada). Retorna closed =
-- true só para quem efetivamente fechou (alerta de recuperação uma vez).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provider_breaker_report_success(
  p_channel text,
  p_send_started_at timestamptz DEFAULT NULL
)
RETURNS TABLE (closed boolean, first_opened_at timestamptz, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r public.provider_circuit_breakers%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.provider_circuit_breakers b
  WHERE b.channel = p_channel AND b.state <> 'closed'
  FOR UPDATE;
  IF NOT FOUND
     OR (p_send_started_at IS NOT NULL AND r.opened_at IS NOT NULL AND p_send_started_at < r.opened_at) THEN
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;
  UPDATE public.provider_circuit_breakers b
     SET state = 'closed', open_count = 0, backoff_until = NULL,
         first_opened_at = NULL, opened_at = NULL, reason = NULL,
         probe_holder = NULL, probe_started_at = NULL,
         last_alert_at = NULL, closed_at = now(), updated_at = now()
   WHERE b.channel = p_channel;
  RETURN QUERY SELECT true, r.first_opened_at, r.reason;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pergunta de cada worker antes de enviar:
--   'closed' -> envia normalmente.
--   'open'   -> não envia (nada é consumido); retry_at = próxima chance.
--   'probe'  -> este holder pode fazer UM envio de prova (half_open). Só um
--               holder por vez; se ele sumir, outro assume após p_probe_ttl.
-- alert_due: lembrete a cada 15 min enquanto não fecha.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provider_breaker_acquire(
  p_channel text,
  p_holder text,
  p_probe_ttl_seconds integer DEFAULT 300
)
RETURNS TABLE (
  decision text,
  state text,
  reason text,
  last_error text,
  first_opened_at timestamptz,
  retry_at timestamptz,
  alert_due boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  c_alert_every constant interval := interval '15 minutes';
  v_ttl interval := make_interval(secs => greatest(30, least(coalesce(p_probe_ttl_seconds, 300), 1800)));
  r public.provider_circuit_breakers%ROWTYPE;
  v_decision text := 'open';
  v_alert boolean := false;
BEGIN
  -- Caminho comum: fechado, sem trava.
  SELECT * INTO r FROM public.provider_circuit_breakers b WHERE b.channel = p_channel;
  IF NOT FOUND OR r.state = 'closed' THEN
    RETURN QUERY SELECT 'closed'::text, 'closed'::text, NULL::text, NULL::text,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT * INTO r FROM public.provider_circuit_breakers b
  WHERE b.channel = p_channel
  FOR UPDATE;
  IF r.state = 'closed' THEN
    RETURN QUERY SELECT 'closed'::text, 'closed'::text, NULL::text, NULL::text,
      NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  IF (r.state = 'open' AND coalesce(r.backoff_until, now()) <= now())
     OR (r.state = 'half_open' AND (r.probe_holder IS NOT DISTINCT FROM p_holder
                                    OR r.probe_started_at IS NULL
                                    OR r.probe_started_at <= now() - v_ttl)) THEN
    v_decision := 'probe';
    UPDATE public.provider_circuit_breakers b
       SET state = 'half_open', probe_holder = p_holder,
           probe_started_at = CASE WHEN r.state = 'half_open' AND r.probe_holder IS NOT DISTINCT FROM p_holder
                                   THEN coalesce(r.probe_started_at, now()) ELSE now() END,
           updated_at = now()
     WHERE b.channel = p_channel;
  END IF;

  IF r.last_alert_at IS NULL OR r.last_alert_at <= now() - c_alert_every THEN
    v_alert := true;
    UPDATE public.provider_circuit_breakers b SET last_alert_at = now() WHERE b.channel = p_channel;
  END IF;

  SELECT * INTO r FROM public.provider_circuit_breakers b WHERE b.channel = p_channel;
  RETURN QUERY SELECT v_decision, r.state, r.reason, r.last_error, r.first_opened_at,
    CASE WHEN r.state = 'half_open' THEN r.probe_started_at + v_ttl ELSE r.backoff_until END,
    v_alert;
END;
$$;

-- ---------------------------------------------------------------------------
-- O holder da prova terminou sem obter resposta conclusiva (ex.: o item saiu
-- da jornada antes de enviar): devolve a vez; o próximo acquire pode provar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provider_breaker_release_probe(p_channel text, p_holder text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH released AS (
    UPDATE public.provider_circuit_breakers b
       SET state = 'open', probe_holder = NULL, probe_started_at = NULL, updated_at = now()
     WHERE b.channel = p_channel AND b.state = 'half_open' AND b.probe_holder = p_holder
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$$;

REVOKE ALL ON FUNCTION public.provider_breaker_report_failure(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_breaker_report_success(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_breaker_acquire(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.provider_breaker_release_probe(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_breaker_report_failure(text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_breaker_report_success(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_breaker_acquire(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_breaker_release_probe(text, text) TO service_role;
