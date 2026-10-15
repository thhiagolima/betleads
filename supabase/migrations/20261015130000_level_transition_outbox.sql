-- WHK-01 (Fase D) — level transition leaves the deposit transaction.
--
-- Before: record_financial_webhook_event() updates players.total_depositado,
-- which fires trg_players_journey_level_transition. Its function
-- (20261014200000) UPDATEs journey_enrollments and INSERTs journey_enrollments /
-- journey_events inside the deposit transaction: a lock wait, FK error or
-- timeout there rolled the deposit back.
--
-- After:
--   * transition_journey_level_on_deposit() (same trigger, same name, so the
--     trigger on players is not touched and no lock on players is needed) only
--     computes the two levels (journey_level_for_total = one PK lookup on
--     gamification_settings each) and, when the level changed, INSERTs one row
--     into journey_level_outbox. No journey table is read or written.
--   * process_journey_level_outbox(p_limit) applies exactly the previous
--     transition semantics per outbox row, inside a subtransaction
--     (BEGIN ... EXCEPTION), so one failing row is recorded (attempts,
--     last_error, backoff) and does not block or roll back the others.
--   * pg_cron runs it every minute (pure SQL, no app route): a level journey
--     starts at most ~60 s (+ processing) after the deposit commits.
--
-- Ordering: rows of the same player are applied strictly in id order. A row is
-- claimable only when no earlier pending row of the same player exists, so a
-- bronze->silver row can never be applied after the silver->gold row (which
-- would exit the gold enrollment). A failing row blocks only that player's
-- later rows until it succeeds or is dead-lettered.
--
-- Concurrency: rows are claimed with FOR UPDATE SKIP LOCKED and marked
-- processed in the same subtransaction as their effects, so two concurrent
-- processors never apply the same row twice.
--
-- Semantics kept from 20261014200000 (now evaluated at processing time):
--   * exit every active/waiting/paused_by_priority enrollment of the
--     progressao_niveis family (exit_reason 'level_changed', claimed_* cleared)
--     with one 'level_changed' event each (same detail keys);
--   * pick the active nivel_alterado journey of the new level (priority,
--     updated_at, id) and, unless the level is 'novice', enroll with
--     entry_key 'level:<level>', the journey version, the same metadata
--     (deposit_id = latest approved deposit at deposit time, captured by the
--     trigger) and a 'level_entered' event when the enrollment was created.
--
-- Not applied automatically. CREATE OR REPLACE FUNCTION does not lock players.

SET lock_timeout = '5s';

-- ============================================================
-- 1) Outbox table
-- ============================================================
-- No FKs on purpose: the INSERT runs inside the deposit transaction and must
-- not fail or take locks on other tables. Rows of deleted players are skipped
-- by the worker.
CREATE TABLE IF NOT EXISTS public.journey_level_outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  player_id uuid NOT NULL,
  previous_total numeric,
  current_total numeric,
  previous_level text NOT NULL,
  current_level text NOT NULL,
  deposit_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dead_at timestamptz,
  result text
);

COMMENT ON TABLE public.journey_level_outbox IS
  'WHK-01: level changes enqueued by trg_players_journey_level_transition; applied by process_journey_level_outbox() (pg_cron, every minute).';
COMMENT ON COLUMN public.journey_level_outbox.processed_at IS
  'Set in the same subtransaction as the journey effects. NULL = pending (or dead when dead_at is set).';
COMMENT ON COLUMN public.journey_level_outbox.dead_at IS
  'Set after max attempts. Dead rows are no longer retried and no longer block later rows of the player.';
COMMENT ON COLUMN public.journey_level_outbox.result IS
  'applied | entered | no_target | player_not_found | same_level.';

-- Pending rows in claim order.
CREATE INDEX IF NOT EXISTS journey_level_outbox_pending_idx
  ON public.journey_level_outbox (next_attempt_at, id)
  WHERE processed_at IS NULL AND dead_at IS NULL;

-- "Is there an earlier pending row for this player?"
CREATE INDEX IF NOT EXISTS journey_level_outbox_player_pending_idx
  ON public.journey_level_outbox (tenant_id, player_id, id)
  WHERE processed_at IS NULL AND dead_at IS NULL;

-- Retention of processed rows.
CREATE INDEX IF NOT EXISTS journey_level_outbox_processed_idx
  ON public.journey_level_outbox (processed_at)
  WHERE processed_at IS NOT NULL;

ALTER TABLE public.journey_level_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.journey_level_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.journey_level_outbox_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.journey_level_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.journey_level_outbox_id_seq TO service_role;

-- ============================================================
-- 2) Trigger function: enqueue only
-- ============================================================
CREATE OR REPLACE FUNCTION public.transition_journey_level_on_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_level text;
  v_current_level text;
  v_deposit_id uuid;
BEGIN
  IF coalesce(NEW.total_depositado, 0) <= coalesce(OLD.total_depositado, 0) THEN
    RETURN NEW;
  END IF;

  v_previous_level := public.journey_level_for_total(OLD.tenant_id, OLD.total_depositado);
  v_current_level := public.journey_level_for_total(NEW.tenant_id, NEW.total_depositado);
  IF v_previous_level = v_current_level THEN
    RETURN NEW;
  END IF;

  -- Same lookup as before, captured now so the worker records the deposit that
  -- caused the change even if another one is approved before it runs.
  -- Index: deposits_tenant_player_status_idx (one player's rows).
  SELECT id INTO v_deposit_id
  FROM public.deposits
  WHERE tenant_id = NEW.tenant_id
    AND player_id = NEW.id
    AND status = 'aprovado'
  ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1;

  INSERT INTO public.journey_level_outbox (
    tenant_id, player_id, previous_total, current_total,
    previous_level, current_level, deposit_id
  ) VALUES (
    NEW.tenant_id, NEW.id, OLD.total_depositado, NEW.total_depositado,
    v_previous_level, v_current_level, v_deposit_id
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_journey_level_on_deposit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_journey_level_on_deposit() TO service_role;

-- ============================================================
-- 3) Apply one outbox row (the former trigger body)
-- ============================================================
-- Returns the result label. Raises on any error; the caller wraps it in a
-- subtransaction.
CREATE OR REPLACE FUNCTION public.apply_journey_level_transition(
  p_row public.journey_level_outbox
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_journey record;
  v_enrollment_id uuid;
BEGIN
  IF p_row.previous_level = p_row.current_level THEN
    RETURN 'same_level';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_row.player_id AND tenant_id = p_row.tenant_id
  ) THEN
    RETURN 'player_not_found';
  END IF;

  SELECT id, version
    INTO v_target_journey
  FROM public.journeys
  WHERE tenant_id = p_row.tenant_id
    AND status = 'active'
    AND conflict_family = 'progressao_niveis'
    AND trigger_type = 'nivel_alterado'
    AND coalesce(trigger_config->>'level', '') = p_row.current_level
  ORDER BY journey_priority ASC, updated_at ASC, id ASC
  LIMIT 1;

  WITH exited AS (
    UPDATE public.journey_enrollments enrollment
    SET status = 'exited',
        exited_at = now(),
        exit_reason = 'level_changed',
        claimed_at = null,
        claimed_by = null
    FROM public.journeys journey
    WHERE enrollment.journey_id = journey.id
      AND enrollment.tenant_id = p_row.tenant_id
      AND enrollment.player_id = p_row.player_id
      AND journey.conflict_family = 'progressao_niveis'
      AND enrollment.status::text IN ('active', 'waiting', 'paused_by_priority')
    RETURNING enrollment.id, enrollment.journey_id
  )
  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  SELECT p_row.tenant_id, journey_id, id, 'level_changed', jsonb_build_object(
    'from_level', p_row.previous_level,
    'to_level', p_row.current_level,
    'previous_total_deposited', p_row.previous_total,
    'current_total_deposited', p_row.current_total
  )
  FROM exited;

  IF v_target_journey.id IS NULL OR p_row.current_level = 'novice' THEN
    RETURN 'no_target';
  END IF;

  INSERT INTO public.journey_enrollments (
    tenant_id, journey_id, journey_version, player_id, entry_key, metadata
  ) VALUES (
    p_row.tenant_id,
    v_target_journey.id,
    v_target_journey.version,
    p_row.player_id,
    ('level:' || p_row.current_level)::text,
    jsonb_build_object(
      'trigger', 'nivel_alterado',
      'from_level', p_row.previous_level,
      'to_level', p_row.current_level,
      'previous_total_deposited', p_row.previous_total,
      'current_total_deposited', p_row.current_total,
      'deposit_id', p_row.deposit_id
    )
  )
  ON CONFLICT (journey_id, player_id, entry_key) DO NOTHING
  RETURNING id INTO v_enrollment_id;

  IF v_enrollment_id IS NULL THEN
    RETURN 'applied';
  END IF;

  INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
  VALUES (
    p_row.tenant_id,
    v_target_journey.id,
    v_enrollment_id,
    'level_entered',
    jsonb_build_object(
      'from_level', p_row.previous_level,
      'to_level', p_row.current_level,
      'previous_total_deposited', p_row.previous_total,
      'current_total_deposited', p_row.current_total,
      'deposit_id', p_row.deposit_id
    )
  );

  RETURN 'entered';
END;
$$;

REVOKE ALL ON FUNCTION public.apply_journey_level_transition(public.journey_level_outbox)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_journey_level_transition(public.journey_level_outbox)
  TO service_role;

-- ============================================================
-- 4) Worker
-- ============================================================
-- Claims up to p_limit rows per pass (several passes so that consecutive rows
-- of one player are drained in the same run), applies each in its own
-- subtransaction and marks it processed. Errors: attempts + 1, last_error,
-- next_attempt_at = now() + min(2^(attempts-1), 30) minutes; dead after 10.
-- lock_timeout bounds each wait on journey_enrollments (a timed-out row is
-- just retried). The caller bounds the whole call (cron sets
-- statement_timeout).
CREATE OR REPLACE FUNCTION public.process_journey_level_outbox(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  v_max_attempts constant integer := 10;
  v_started timestamptz := clock_timestamp();
  v_ids bigint[];
  v_id bigint;
  v_row public.journey_level_outbox;
  v_result text;
  v_error text;
  v_claimed integer := 0;
  v_applied integer := 0;
  v_failed integer := 0;
  v_dead integer := 0;
  v_purged integer := 0;
  v_pass integer := 0;
BEGIN
  LOOP
    v_pass := v_pass + 1;
    EXIT WHEN v_claimed >= v_limit OR v_pass > 10;

    SELECT array_agg(c.id ORDER BY c.id) INTO v_ids
    FROM (
      SELECT o.id
      FROM public.journey_level_outbox o
      WHERE o.processed_at IS NULL
        AND o.dead_at IS NULL
        AND o.next_attempt_at <= now()
        AND NOT EXISTS (
          SELECT 1
          FROM public.journey_level_outbox p
          WHERE p.tenant_id = o.tenant_id
            AND p.player_id = o.player_id
            AND p.id < o.id
            AND p.processed_at IS NULL
            AND p.dead_at IS NULL
        )
      ORDER BY o.id
      LIMIT v_limit - v_claimed
      FOR UPDATE OF o SKIP LOCKED
    ) c;

    EXIT WHEN v_ids IS NULL;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_claimed := v_claimed + 1;

      -- Re-read under the lock we hold; skip if another processor finished it
      -- between its commit and our claim (defensive, the claim already
      -- filters processed rows).
      SELECT * INTO v_row
      FROM public.journey_level_outbox
      WHERE id = v_id AND processed_at IS NULL AND dead_at IS NULL;
      CONTINUE WHEN NOT FOUND;

      BEGIN
        v_result := public.apply_journey_level_transition(v_row);
        UPDATE public.journey_level_outbox
        SET processed_at = clock_timestamp(),
            attempts = attempts + 1,
            result = v_result,
            last_error = CASE WHEN v_result = 'player_not_found' THEN v_result ELSE last_error END
        WHERE id = v_id;
        v_applied := v_applied + 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
        UPDATE public.journey_level_outbox
        SET attempts = attempts + 1,
            last_error = left(SQLSTATE || ': ' || coalesce(v_error, ''), 1000),
            next_attempt_at = now() + make_interval(mins => least(30, power(2, attempts)::integer)),
            dead_at = CASE WHEN attempts + 1 >= v_max_attempts THEN clock_timestamp() END
        WHERE id = v_id;
        v_failed := v_failed + 1;
        IF v_row.attempts + 1 >= v_max_attempts THEN
          v_dead := v_dead + 1;
        END IF;
      END;
    END LOOP;
  END LOOP;

  -- Retention: processed rows older than 30 days, bounded per run.
  DELETE FROM public.journey_level_outbox
  WHERE id IN (
    SELECT id FROM public.journey_level_outbox
    WHERE processed_at < now() - interval '30 days'
    ORDER BY processed_at
    LIMIT 1000
  );
  GET DIAGNOSTICS v_purged = ROW_COUNT;

  -- One run row per call (same convention as the other jobs) so
  -- observability_job_health() shows liveness. Logging must never undo the
  -- applied rows.
  BEGIN
    INSERT INTO public.dispatcher_runs (
      channel, kind, job, status, started_at, heartbeat_at, finished_at,
      duration_ms, claimed, sent, errors, stop_reason
    ) VALUES (
      'journey_level_outbox', 'tick', 'journey_level_outbox',
      CASE WHEN v_failed = 0 THEN 'succeeded' WHEN v_applied = 0 THEN 'failed' ELSE 'partial' END,
      v_started, clock_timestamp(), clock_timestamp(),
      floor(extract(epoch FROM clock_timestamp() - v_started) * 1000)::integer,
      v_claimed, v_applied, v_failed,
      CASE WHEN v_claimed >= v_limit THEN 'limit' ELSE 'drained' END
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'claimed', v_claimed,
    'applied', v_applied,
    'failed', v_failed,
    'dead', v_dead,
    'purged', v_purged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_journey_level_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_journey_level_outbox(integer) TO service_role;

-- ============================================================
-- 5) Monitoring
-- ============================================================
CREATE OR REPLACE FUNCTION public.observability_journey_level_outbox()
RETURNS TABLE (
  pending bigint,
  ready bigint,
  retrying bigint,
  oldest_pending_age_seconds integer,
  dead bigint,
  dead_last_24h bigint,
  processed_last_hour bigint,
  last_processed_at timestamptz,
  last_error text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM public.journey_level_outbox
      WHERE processed_at IS NULL AND dead_at IS NULL),
    (SELECT count(*) FROM public.journey_level_outbox
      WHERE processed_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()),
    (SELECT count(*) FROM public.journey_level_outbox
      WHERE processed_at IS NULL AND dead_at IS NULL AND attempts > 0),
    (SELECT floor(extract(epoch FROM now() - min(created_at)))::integer
       FROM public.journey_level_outbox
      WHERE processed_at IS NULL AND dead_at IS NULL),
    (SELECT count(*) FROM public.journey_level_outbox WHERE dead_at IS NOT NULL),
    (SELECT count(*) FROM public.journey_level_outbox
      WHERE dead_at >= now() - interval '24 hours'),
    (SELECT count(*) FROM public.journey_level_outbox
      WHERE processed_at >= now() - interval '1 hour'),
    (SELECT max(processed_at) FROM public.journey_level_outbox
      WHERE processed_at >= now() - interval '30 days'),
    (SELECT o.last_error FROM public.journey_level_outbox o
      WHERE o.processed_at IS NULL AND o.last_error IS NOT NULL
      ORDER BY o.id DESC LIMIT 1);
$$;

COMMENT ON FUNCTION public.observability_journey_level_outbox() IS
  'WHK-01: level-transition outbox backlog — pending/ready/retrying, oldest pending age, dead rows, throughput, last error.';

REVOKE ALL ON FUNCTION public.observability_journey_level_outbox() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observability_journey_level_outbox() TO service_role;

-- ============================================================
-- 6) pg_cron: every minute, pure SQL
-- ============================================================
-- Guarded so the migration also loads where pg_cron is absent (PGlite tests).
DO $$
DECLARE
  v_job record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE WARNING 'pg_cron not installed: schedule process_journey_level_outbox() manually';
    RETURN;
  END IF;

  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'betleads-journey-level-outbox'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'betleads-journey-level-outbox',
    '* * * * *',
    $job$set statement_timeout = '50s'; select public.process_journey_level_outbox(500);$job$
  );
END;
$$;

RESET lock_timeout;
