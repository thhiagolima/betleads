-- ENV-09 part 2: threshold-crossing entry for time-based journey triggers.
--
-- Time-based triggers (inactivity, sem_login_*, recuperacao_vip, vip_esfriando,
-- dinheiro_parado, ...) become true without any event: the clock crosses
-- greatest(activity fields) + hours. The worker behind
-- /api/public/hooks/journey-crossing asks journey_crossing_candidates() only for
-- players whose crossing time fell in (watermark, now] and enrolls them with the
-- same matcher/entry_key as the full scanner and the webhook path.
--
-- Watermark semantics (see src/lib/journey-crossing.server.ts):
--   * watermark_at: every crossing <= watermark_at was processed.
--   * pending_until + cursor_*: a window being paged in (crossing_at, player_id)
--     keyset order; resumes exactly where the last page stopped.
--   * First sight of a journey: watermark_at = now() (no backfill; players that
--     already crossed are covered by the full scanner), or a past
--     trigger_config.start_after (explicit catch-up).
--
-- Index plan: (tenant_id, ultimo_login) and (tenant_id, ultimo_deposito) already
-- exist in production (players_tenant_ultimo_login_idx,
-- players_tenant_ultimo_deposito_idx). Only (tenant_id, ultimo_jogo) is missing.
-- players is ~32k rows / 13 MB, so a plain CREATE INDEX holds the SHARE lock for
-- well under a second. To avoid even that, run BEFORE this migration, outside a
-- transaction (SQL editor / psql, not inside BEGIN):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS players_tenant_ultimo_jogo_idx
--     ON public.players (tenant_id, ultimo_jogo DESC NULLS LAST);
-- and the IF NOT EXISTS below becomes a no-op.
--
-- Not applied automatically. lock_timeout makes it fail fast instead of queueing
-- behind webhook writes on players.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS players_tenant_ultimo_jogo_idx
  ON public.players (tenant_id, ultimo_jogo DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS public.journey_crossing_states (
  journey_id uuid PRIMARY KEY REFERENCES public.journeys(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_version integer NOT NULL CHECK (journey_version > 0),
  watermark_at timestamptz NOT NULL DEFAULT now(),
  pending_until timestamptz,
  cursor_crossing_at timestamptz,
  cursor_player_id uuid,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  last_run_at timestamptz,
  last_selected integer NOT NULL DEFAULT 0 CHECK (last_selected >= 0),
  last_enrolled integer NOT NULL DEFAULT 0 CHECK (last_enrolled >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pending_until IS NULL OR pending_until > watermark_at),
  CHECK ((cursor_crossing_at IS NULL) = (cursor_player_id IS NULL))
);

CREATE INDEX IF NOT EXISTS journey_crossing_states_tenant_idx
  ON public.journey_crossing_states (tenant_id, journey_id);

ALTER TABLE public.journey_crossing_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journey_crossing_states_tenant_rls ON public.journey_crossing_states;
CREATE POLICY journey_crossing_states_tenant_rls ON public.journey_crossing_states
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

REVOKE ALL ON public.journey_crossing_states FROM anon, authenticated;
GRANT SELECT ON public.journey_crossing_states TO authenticated;
GRANT ALL ON public.journey_crossing_states TO service_role;

DROP TRIGGER IF EXISTS journey_crossing_states_set_updated_at ON public.journey_crossing_states;
CREATE TRIGGER journey_crossing_states_set_updated_at
  BEFORE UPDATE ON public.journey_crossing_states
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Players whose threshold crossing time, greatest(selected fields) + hours, is in
-- (p_from, p_to], after the (p_after_crossing_at, p_after_player_id) keyset.
-- Each selected field contributes an indexable range on (tenant_id, field); the
-- arms are OR-ed (BitmapOr) and the exact greatest() bound is re-checked, so a
-- player whose later activity moved its crossing out of the window is dropped.
-- plpgsql so the use_* flags are plan-time constants for each call.
CREATE OR REPLACE FUNCTION public.journey_crossing_candidates(
  p_tenant_id uuid,
  p_fields text[],
  p_hours double precision,
  p_from timestamptz,
  p_to timestamptz,
  p_after_crossing_at timestamptz DEFAULT NULL,
  p_after_player_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (player_id uuid, crossing_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_offset interval;
  v_lo timestamptz;
  v_hi timestamptz;
  v_after timestamptz;
  v_login boolean := 'ultimo_login' = ANY (coalesce(p_fields, '{}'::text[]));
  v_jogo boolean := 'ultimo_jogo' = ANY (coalesce(p_fields, '{}'::text[]));
  v_deposito boolean := 'ultimo_deposito' = ANY (coalesce(p_fields, '{}'::text[]));
BEGIN
  IF p_tenant_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_hours IS NULL OR p_hours < 0 OR NOT (v_login OR v_jogo OR v_deposito) THEN
    RETURN;
  END IF;
  v_offset := make_interval(secs => p_hours * 3600);
  v_lo := p_from - v_offset;
  v_hi := p_to - v_offset;
  v_after := p_after_crossing_at - v_offset;

  RETURN QUERY
  SELECT c.id, c.activity_at + v_offset
  FROM (
    SELECT p.id,
           greatest(
             CASE WHEN v_login THEN p.ultimo_login END,
             CASE WHEN v_jogo THEN p.ultimo_jogo END,
             CASE WHEN v_deposito THEN p.ultimo_deposito END
           ) AS activity_at
    FROM public.players p
    WHERE p.tenant_id = p_tenant_id
      AND (
        (v_login AND p.ultimo_login > v_lo AND p.ultimo_login <= v_hi)
        OR (v_jogo AND p.ultimo_jogo > v_lo AND p.ultimo_jogo <= v_hi)
        OR (v_deposito AND p.ultimo_deposito > v_lo AND p.ultimo_deposito <= v_hi)
      )
  ) c
  WHERE c.activity_at > v_lo
    AND c.activity_at <= v_hi
    AND (
      p_after_crossing_at IS NULL
      OR p_after_player_id IS NULL
      OR (c.activity_at, c.id) > (v_after, p_after_player_id)
    )
  ORDER BY c.activity_at, c.id
  LIMIT greatest(1, least(coalesce(p_limit, 500), 2000));
END;
$$;

REVOKE ALL ON FUNCTION public.journey_crossing_candidates(uuid, text[], double precision, timestamptz, timestamptz, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_crossing_candidates(uuid, text[], double precision, timestamptz, timestamptz, timestamptz, uuid, integer)
  TO service_role;

COMMENT ON TABLE public.journey_crossing_states IS
  'Per-journey watermark of the threshold-crossing worker (time-based triggers, ENV-09).';
COMMENT ON FUNCTION public.journey_crossing_candidates(uuid, text[], double precision, timestamptz, timestamptz, timestamptz, uuid, integer) IS
  'Players whose greatest(p_fields) + p_hours fell in (p_from, p_to], keyset-paged. Service role only.';

-- Cron: every minute, same pattern as betleads-scan-journeys. The worker is
-- fail-closed (JOURNEYS_SCANNER_ENABLED, JOURNEYS_CROSSING_ENABLED, canary scope).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE v_job record;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'betleads-journey-crossing'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'betleads-journey-crossing',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/journey-crossing',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $job$
);

RESET lock_timeout;
