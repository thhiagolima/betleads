
-- ============================================================
-- 1) dispatch_rate_state — controle de cadência por canal
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dispatch_rate_state (
  channel TEXT PRIMARY KEY,
  target_per_minute INT NOT NULL DEFAULT 60,
  max_per_minute INT NOT NULL DEFAULT 70,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_in_window INT NOT NULL DEFAULT 0,
  backoff_until TIMESTAMPTZ,
  last_provider_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.dispatch_rate_state TO authenticated;
GRANT ALL ON public.dispatch_rate_state TO service_role;

ALTER TABLE public.dispatch_rate_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth read dispatch_rate_state" ON public.dispatch_rate_state;
CREATE POLICY "auth read dispatch_rate_state" ON public.dispatch_rate_state
  FOR SELECT TO authenticated USING (true);

-- seeds: SMS 60/70, Email 80/100 (defaults conservadores)
INSERT INTO public.dispatch_rate_state (channel, target_per_minute, max_per_minute)
VALUES ('sms', 60, 70), ('email', 80, 100)
ON CONFLICT (channel) DO NOTHING;

-- ============================================================
-- 2) dispatcher_runs — histórico append-only por execução
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dispatcher_runs (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tick', -- tick | recovery | campaign
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  queue_before INT NOT NULL DEFAULT 0,
  claimed INT NOT NULL DEFAULT 0,
  sent INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  rescheduled INT NOT NULL DEFAULT 0,
  rate_limited INT NOT NULL DEFAULT 0,
  lock_recovered INT NOT NULL DEFAULT 0,
  target_rate INT,
  actual_rate INT,
  stop_reason TEXT,
  provider TEXT,
  last_provider_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispatcher_runs_channel_started
  ON public.dispatcher_runs (channel, started_at DESC);

GRANT SELECT ON public.dispatcher_runs TO authenticated;
GRANT ALL ON public.dispatcher_runs TO service_role;

ALTER TABLE public.dispatcher_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth read dispatcher_runs" ON public.dispatcher_runs;
CREATE POLICY "auth read dispatcher_runs" ON public.dispatcher_runs
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- 3) locked_at / locked_by nas filas
-- ============================================================
ALTER TABLE public.sms_flow_leads
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

ALTER TABLE public.email_flow_leads
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

-- ============================================================
-- 4) consume_dispatch_budget — token bucket por minuto
-- ============================================================
CREATE OR REPLACE FUNCTION public.consume_dispatch_budget(
  p_channel TEXT,
  p_want INT
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.dispatch_rate_state;
  v_grant INT;
BEGIN
  SELECT * INTO v_state FROM public.dispatch_rate_state
    WHERE channel = p_channel
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- backoff ativo? bloqueia tudo até passar.
  IF v_state.backoff_until IS NOT NULL AND v_state.backoff_until > now() THEN
    RETURN 0;
  END IF;

  -- rola janela de 60s
  IF v_state.window_started_at < now() - interval '60 seconds' THEN
    v_state.window_started_at := now();
    v_state.sent_in_window := 0;
  END IF;

  v_grant := LEAST(GREATEST(p_want, 0), GREATEST(v_state.max_per_minute - v_state.sent_in_window, 0));

  UPDATE public.dispatch_rate_state
     SET window_started_at = v_state.window_started_at,
         sent_in_window = v_state.sent_in_window + v_grant,
         updated_at = now()
   WHERE channel = p_channel;

  RETURN v_grant;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_dispatch_budget(TEXT, INT) TO service_role;

-- ============================================================
-- 5) register_provider_throttle — registra 429 e desacelera
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_provider_throttle(
  p_channel TEXT,
  p_retry_after_seconds INT,
  p_error TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.dispatch_rate_state
     SET backoff_until = GREATEST(COALESCE(backoff_until, now()), now() + make_interval(secs => GREATEST(p_retry_after_seconds, 5))),
         last_provider_error = LEFT(COALESCE(p_error, ''), 800),
         updated_at = now()
   WHERE channel = p_channel;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_provider_throttle(TEXT, INT, TEXT) TO service_role;

-- ============================================================
-- 6) Atualizar claims para setar locked_at/locked_by
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_sms_flow_leads(p_limit integer)
 RETURNS SETOF sms_flow_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.sms_flow_leads l
     SET next_run_at = now() + interval '5 minutes',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT id FROM public.sms_flow_leads
       WHERE status IN ('pending','running')
         AND next_run_at <= now()
       ORDER BY next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE l.id = picked.id
  RETURNING l.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_email_flow_leads(p_limit integer)
 RETURNS SETOF email_flow_leads
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.email_flow_leads l
     SET next_run_at = now() + interval '5 minutes',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT id FROM public.email_flow_leads
       WHERE status IN ('pending','running')
         AND next_run_at <= now()
       ORDER BY next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE l.id = picked.id
  RETURNING l.*;
END;
$function$;

-- ============================================================
-- 7) recover_stuck_*  — libera leads/campanhas travados há >5min
-- ============================================================
CREATE OR REPLACE FUNCTION public.recover_stuck_sms_leads()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.sms_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           next_run_at = now(),
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stuck_email_leads()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.email_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           next_run_at = now(),
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stuck_email_campaigns()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.email_campaigns
       SET locked_at = NULL,
           locked_by = NULL,
           status = 'agendada',
           scheduled_at = now(),
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '15 minutes'
       AND status = 'enviando'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stuck_email_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stuck_email_campaigns() TO service_role;

-- ============================================================
-- 8) claim_due_email_campaigns — claim atômico com lock
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_due_email_campaigns(p_limit integer)
RETURNS SETOF email_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.email_campaigns c
     SET status = 'enviando',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT id FROM public.email_campaigns
       WHERE status = 'agendada'
         AND scheduled_at <= now()
       ORDER BY scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) TO service_role;
