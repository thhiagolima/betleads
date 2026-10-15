-- Journey P0 rules (docs/ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md)
--
-- 1. One open enrollment per (journey, player) for non-express journeys (E-01).
--    A PIX journey used to open one enrollment per pending PIX and sent one
--    SMS per enrollment (16 SMS in 2 minutes to one player). Enforced here so
--    the scanner, the webhook entry, the threshold crossing and the level
--    outbox all obey it. Express journeys (Saque pago) keep one enrollment per
--    occurrence: each approved withdrawal gets its own message (D-8).
-- 2. Per-journey, per-player send caps read from journeys.entry_rules (D-8):
--    `max_per_player_day` (BRT calendar day) and `min_interval_minutes`.
--    Applied before the express bypass, so they also bind express journeys.
-- 3. Sweep of `paused_by_priority` enrollments (S-02): they are never claimed,
--    so their exit rules never ran and they stayed open forever.

-- ---------------------------------------------------------------------------
-- 1. Single open enrollment
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_single_open_journey_enrollment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.player_id IS NULL
     OR NEW.status::text NOT IN ('active', 'waiting', 'paused_by_priority') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journeys
    WHERE id = NEW.journey_id AND coalesce(express, false)
  ) THEN
    RETURN NEW;
  END IF;
  -- Serialize concurrent entries of the same player into the same journey.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.journey_id::text || ':' || NEW.player_id::text || ':single-open', 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.journey_enrollments e
    WHERE e.journey_id = NEW.journey_id
      AND e.player_id = NEW.player_id
      AND e.status::text IN ('active', 'waiting', 'paused_by_priority')
  ) THEN
    -- Silently skipped: callers insert with ON CONFLICT DO NOTHING semantics.
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_single_open_journey_enrollment ON public.journey_enrollments;
CREATE TRIGGER trg_single_open_journey_enrollment
BEFORE INSERT ON public.journey_enrollments
FOR EACH ROW EXECUTE FUNCTION public.enforce_single_open_journey_enrollment();

-- ---------------------------------------------------------------------------
-- 2. Reservation with per-journey, per-player caps
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_journey_delivery_v2(
  p_tenant_id uuid, p_journey_id uuid, p_enrollment_id uuid, p_step_id uuid,
  p_step_position integer, p_player_id uuid, p_channel text,
  p_daily_limit integer, p_cooldown_hours integer
)
RETURNS TABLE (execution_id uuid, idempotency_key uuid, retry_at timestamptz, blocked_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rules jsonb;
  v_max_day integer;
  v_interval integer;
  v_day_start timestamptz;
  v_sent_today integer;
  v_last_sent timestamptz;
BEGIN
  IF p_player_id IS NULL THEN
    RAISE EXCEPTION 'invalid journey delivery reservation';
  END IF;

  SELECT entry_rules INTO v_rules
  FROM public.journeys
  WHERE id = p_journey_id AND tenant_id = p_tenant_id;

  v_max_day := CASE WHEN coalesce(v_rules->>'max_per_player_day', '') ~ '^[0-9]+$'
                    THEN (v_rules->>'max_per_player_day')::integer END;
  v_interval := CASE WHEN coalesce(v_rules->>'min_interval_minutes', '') ~ '^[0-9]+$'
                     THEN (v_rules->>'min_interval_minutes')::integer END;

  -- Caps apply only to a step not sent yet: an already accepted step must reach
  -- the inner function, which answers `already_sent` and advances.
  IF coalesce(v_max_day, 0) > 0 OR coalesce(v_interval, 0) > 0 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.journey_enrollments n
      JOIN public.journey_step_executions e
        ON e.enrollment_id = n.id AND e.loop_iteration = n.loop_iteration
      WHERE n.id = p_enrollment_id AND n.tenant_id = p_tenant_id
        AND e.step_position = p_step_position
        AND e.status IN ('sent', 'delivered')
    ) THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(p_journey_id::text || ':' || p_player_id::text || ':player-cap', 0)
      );
      v_day_start := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                     AT TIME ZONE 'America/Sao_Paulo';
      -- `claimed` counts too: it is a send in flight. Rows of this enrollment
      -- are excluded so a retried attempt never blocks itself.
      SELECT
        count(*) FILTER (WHERE e.created_at >= v_day_start),
        max(e.created_at)
      INTO v_sent_today, v_last_sent
      FROM public.journey_step_executions e
      JOIN public.journey_enrollments n ON n.id = e.enrollment_id
      WHERE e.journey_id = p_journey_id
        AND e.tenant_id = p_tenant_id
        AND n.player_id = p_player_id
        AND e.enrollment_id <> p_enrollment_id
        AND e.channel IS NOT NULL
        AND e.status IN ('claimed', 'sent', 'delivered')
        AND e.created_at >= least(v_day_start, now() - make_interval(mins => coalesce(v_interval, 0)));

      IF coalesce(v_max_day, 0) > 0 AND v_sent_today >= v_max_day THEN
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::timestamptz,
          'journey_player_daily_cap'::text;
        RETURN;
      END IF;
      IF coalesce(v_interval, 0) > 0 AND v_last_sent IS NOT NULL
         AND v_last_sent > now() - make_interval(mins => v_interval) THEN
        RETURN QUERY SELECT NULL::uuid, NULL::uuid,
          v_last_sent + make_interval(mins => v_interval),
          'journey_player_min_interval'::text;
        RETURN;
      END IF;
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.reserve_journey_delivery_with_contact_limits(
    p_tenant_id, p_journey_id, p_enrollment_id, p_step_id, p_step_position,
    p_player_id, p_channel, p_daily_limit, p_cooldown_hours
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_journey_delivery_v2(
  uuid, uuid, uuid, uuid, integer, uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_journey_delivery_v2(
  uuid, uuid, uuid, uuid, integer, uuid, text, integer, integer
) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Sweep of priority-paused enrollments
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS journey_enrollments_priority_paused_idx
  ON public.journey_enrollments (journey_id)
  WHERE status = 'paused_by_priority';

CREATE OR REPLACE FUNCTION public.sweep_priority_paused_enrollments(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH evaluated AS (
    SELECT e.id, e.tenant_id, e.journey_id,
      CASE
        WHEN j.status::text = 'archived' THEN 'journey_archived'
        WHEN coalesce(j.exit_rules->>'deposit', '') = 'true'
             AND p.ultimo_deposito > e.entered_at THEN 'deposit'
        WHEN coalesce(j.exit_rules->>'first_deposit', '') = 'true'
             AND p.ftd_em > e.entered_at THEN 'first_deposit'
        WHEN coalesce(j.exit_rules->>'inactivity_over_hours', '') ~ '^[0-9]+(\.[0-9]+)?$'
             AND (CASE coalesce(j.trigger_config->>'field', 'ultimo_deposito')
                    WHEN 'ultimo_login' THEN p.ultimo_login
                    WHEN 'ultimo_jogo' THEN p.ultimo_jogo
                    ELSE p.ultimo_deposito
                  END) <= now() - make_interval(
                    secs => ((j.exit_rules->>'inactivity_over_hours')::numeric * 3600)::double precision)
          THEN 'inactivity_threshold'
      END AS reason
    FROM public.journey_enrollments e
    JOIN public.journeys j ON j.id = e.journey_id
    LEFT JOIN public.players p ON p.id = e.player_id
    WHERE e.status = 'paused_by_priority'
  ),
  picked AS (
    SELECT ev.id, ev.reason
    FROM evaluated ev
    JOIN public.journey_enrollments e ON e.id = ev.id
    WHERE ev.reason IS NOT NULL
    LIMIT greatest(1, coalesce(p_limit, 500))
    FOR UPDATE OF e SKIP LOCKED
  ),
  exited AS (
    UPDATE public.journey_enrollments e
    SET status = 'exited', exited_at = now(), exit_reason = picked.reason,
        claimed_at = NULL, claimed_by = NULL
    FROM picked
    WHERE e.id = picked.id AND e.status = 'paused_by_priority'
    RETURNING e.id, e.tenant_id, e.journey_id, picked.reason
  ),
  logged AS (
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    SELECT tenant_id, journey_id, id, 'exited',
           jsonb_build_object('reason', reason, 'source', 'priority_sweep')
    FROM exited
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_priority_paused_enrollments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_priority_paused_enrollments(integer) TO service_role;
