-- Demo tenant, second layer: workers and crons never claim demo-tenant work.
--
-- The send paths already refuse demo tenants (fail-closed TS guards). This
-- migration keeps the demo snapshot frozen by making every queue claim,
-- recovery sweep and per-tenant cron loop skip demo tenants, so their rows
-- are never even picked up, locked or rewritten.
--
-- Each function below is the LATEST definition (last migration, lexical
-- order) copied verbatim; the only change is the demo filter on the claimed /
-- iterated set:
--   * row queues:    AND NOT public.is_demo_tenant(<alias>.tenant_id)
--                    (null/unknown tenant_id -> false, so legacy rows with a
--                    null tenant_id stay claimable)
--   * tenant loops:  NOT t.is_demo / WHERE NOT is_demo on public.tenants
-- `create or replace` keeps the existing privileges; the REVOKE/GRANT lines
-- earlier migrations set for these functions are repeated as they were.
-- `claim_webhook_event` is intentionally left out: demo inbound traffic is
-- already refused before it is recorded (Task 8).
-- Derived-metric crons (dashboard, CRM results, health check) skip demo too:
-- the demo clone computes its aggregates once.

-- ---------------------------------------------------------------------------
-- 1. SMS / e-mail / call queues
--    base: 20260612170605_8b5a8207-7a0f-42ae-9049-cd9fecb44a9f.sql
-- ---------------------------------------------------------------------------
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
      SELECT sl.id FROM public.sms_flow_leads sl
       WHERE sl.status IN ('pending','running')
         AND sl.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'sms' AND p.paused = true AND p.tenant_id = sl.tenant_id
         )
         AND NOT public.is_demo_tenant(sl.tenant_id)
       ORDER BY sl.next_run_at ASC
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
      SELECT el.id FROM public.email_flow_leads el
       WHERE el.status IN ('pending','running')
         AND el.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'email' AND p.paused = true AND p.tenant_id = el.tenant_id
         )
         AND NOT public.is_demo_tenant(el.tenant_id)
       ORDER BY el.next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE l.id = picked.id
  RETURNING l.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_email_campaigns(p_limit integer)
 RETURNS SETOF email_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      SELECT ec.id FROM public.email_campaigns ec
       WHERE ec.status = 'agendada'
         AND ec.scheduled_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'email' AND p.paused = true AND p.tenant_id = ec.tenant_id
         )
         AND NOT public.is_demo_tenant(ec.tenant_id)
       ORDER BY ec.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_call_flow_progress(p_limit integer)
 RETURNS SETOF call_flow_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.call_flow_progress p
     SET next_run_at = now() + interval '5 minutes',
         updated_at = now()
    FROM (
      SELECT cp.id FROM public.call_flow_progress cp
       WHERE cp.status = 'active'
         AND cp.next_run_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state ps
            WHERE ps.channel = 'call' AND ps.paused = true AND ps.tenant_id = cp.tenant_id
         )
         AND NOT public.is_demo_tenant(cp.tenant_id)
       ORDER BY cp.next_run_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE p.id = picked.id
  RETURNING p.*;
END;
$function$;

-- base: 20260722170912_6c167bce-e198-447a-a6fb-16e3dd2fed78.sql
CREATE OR REPLACE FUNCTION public.claim_due_sms_campaigns(p_limit integer)
 RETURNS SETOF public.sms_campaigns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lock TEXT := gen_random_uuid()::text;
BEGIN
  RETURN QUERY
  UPDATE public.sms_campaigns c
     SET status = 'enviando',
         locked_at = now(),
         locked_by = v_lock,
         updated_at = now()
    FROM (
      SELECT sc.id FROM public.sms_campaigns sc
       WHERE sc.scheduled_at <= now()
         AND (
           sc.status = 'agendada'
           OR (
             sc.status = 'enviando'
             AND (sc.locked_at IS NULL OR sc.locked_at < now() - interval '5 minutes')
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.dispatch_pause_state p
            WHERE p.channel = 'sms' AND p.paused = true AND p.tenant_id = sc.tenant_id
         )
         AND NOT public.is_demo_tenant(sc.tenant_id)
       ORDER BY sc.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Stuck-lock recovery sweeps
-- ---------------------------------------------------------------------------
-- base: 20260608002214_bb761f32-8f34-4f39-a4c1-9d5af5fc62f1.sql
CREATE OR REPLACE FUNCTION public.recover_stuck_sms_leads()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.sms_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           -- Preserva o agendamento real (delays de horas/dias).
           -- Só puxa para agora se o next_run_at já estava no passado.
           next_run_at = CASE
             WHEN next_run_at IS NULL OR next_run_at <= now() THEN now()
             ELSE next_run_at
           END,
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
       AND NOT public.is_demo_tenant(tenant_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_stuck_email_leads()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.email_flow_leads
       SET locked_at = NULL,
           locked_by = NULL,
           next_run_at = CASE
             WHEN next_run_at IS NULL OR next_run_at <= now() THEN now()
             ELSE next_run_at
           END,
           attempts = COALESCE(attempts,0) + 1,
           exit_reason = COALESCE(exit_reason,'') || CASE WHEN exit_reason IS NULL THEN 'lock_expired_recovered' ELSE '' END,
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '5 minutes'
       AND status IN ('pending','running')
       AND NOT public.is_demo_tenant(tenant_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;

-- base: 20260607023626_9a3d2657-8f51-47e5-a704-e3c54ea61716.sql
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
       AND NOT public.is_demo_tenant(tenant_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$$;

-- base: 20260721190943_92c12511-8248-4965-8027-f490a7396f2d.sql
CREATE OR REPLACE FUNCTION public.recover_stuck_sms_campaigns()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n INT;
BEGIN
  WITH upd AS (
    UPDATE public.sms_campaigns
       SET locked_at = NULL,
           locked_by = NULL,
           status = 'agendada',
           updated_at = now()
     WHERE locked_at IS NOT NULL
       AND locked_at < now() - interval '15 minutes'
       AND status = 'enviando'
       AND NOT public.is_demo_tenant(tenant_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM upd;
  RETURN COALESCE(v_n, 0);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.recover_stuck_sms_leads() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_email_leads() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_email_campaigns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stuck_email_leads() TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stuck_email_campaigns() TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Journeys
-- ---------------------------------------------------------------------------
-- base: 20261015122000_express_journeys.sql (tenant_scope skips demo tenants)
CREATE OR REPLACE FUNCTION public.claim_journey_enrollments_leased(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer,
  p_tenant_ids uuid[],
  p_journey_ids uuid[],
  p_exclude text[] DEFAULT NULL
)
RETURNS TABLE (id uuid, tenant_id uuid, lease_expires_at timestamptz, step_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 100), 1000)) AS max_items,
      coalesce(nullif(p_worker_id, ''), 'journey-dispatcher:' || gen_random_uuid()::text) AS worker,
      make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))) AS lease
  ),
  tenant_scope AS (
    SELECT t.id AS tenant_id
    FROM public.tenants t
    WHERE (coalesce(cardinality(p_tenant_ids), 0) = 0 OR t.id = ANY(p_tenant_ids))
      AND NOT t.is_demo
  ),
  express_candidates AS (
    -- Per tenant: due, claimable items of ACTIVE EXPRESS journeys only. Uses
    -- journey_enrollments_tenant_journey_idx; empty (and cheap) when the
    -- tenant has no express journey.
    SELECT c.id, c.tenant_id, c.next_run_at, c.created_at, c.step_type, true AS express
    FROM tenant_scope ts
    CROSS JOIN params p
    CROSS JOIN LATERAL (
      SELECT e.id, e.tenant_id, e.next_run_at, e.created_at, s.step_type::text AS step_type
      FROM public.journey_enrollments e
      LEFT JOIN public.journey_steps s
        ON s.journey_id = e.journey_id
       AND s.position = e.current_position
       AND s.is_enabled
      WHERE e.tenant_id = ts.tenant_id
        AND e.journey_id IN (
          SELECT xj.id FROM public.journeys xj
          WHERE xj.tenant_id = ts.tenant_id AND xj.status = 'active' AND xj.express
        )
        AND e.status IN ('active', 'waiting')
        AND e.next_run_at <= now()
        AND (
          e.claimed_at IS NULL
          OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now()
        )
        AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR e.journey_id = ANY(p_journey_ids))
        AND (
          coalesce(cardinality(p_exclude), 0) = 0
          OR s.step_type IS NULL
          OR NOT ((e.tenant_id::text || ':' || s.step_type::text) = ANY(p_exclude))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.dispatch_pause_state ps
          WHERE ps.tenant_id = e.tenant_id
            AND ps.paused
            AND ps.channel = CASE s.step_type::text
              WHEN 'sms' THEN 'sms'
              WHEN 'email' THEN 'email'
              WHEN 'voice' THEN 'call'
            END
        )
      ORDER BY e.next_run_at, e.created_at, e.id
      LIMIT p.max_items
      FOR UPDATE OF e SKIP LOCKED
    ) c
  ),
  regular_candidates AS (
    -- Per tenant: the oldest due, claimable items of non-express journeys.
    SELECT c.id, c.tenant_id, c.next_run_at, c.created_at, c.step_type, false AS express
    FROM tenant_scope ts
    CROSS JOIN params p
    CROSS JOIN LATERAL (
      SELECT e.id, e.tenant_id, e.next_run_at, e.created_at, s.step_type::text AS step_type
      FROM public.journey_enrollments e
      JOIN public.journeys j ON j.id = e.journey_id
      LEFT JOIN public.journey_steps s
        ON s.journey_id = e.journey_id
       AND s.position = e.current_position
       AND s.is_enabled
      WHERE e.tenant_id = ts.tenant_id
        AND e.status IN ('active', 'waiting')
        AND e.next_run_at <= now()
        AND j.status = 'active'
        AND NOT j.express
        AND (
          e.claimed_at IS NULL
          OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now()
        )
        AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR e.journey_id = ANY(p_journey_ids))
        AND (
          coalesce(cardinality(p_exclude), 0) = 0
          OR s.step_type IS NULL
          OR NOT ((e.tenant_id::text || ':' || s.step_type::text) = ANY(p_exclude))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.dispatch_pause_state ps
          WHERE ps.tenant_id = e.tenant_id
            AND ps.paused
            AND ps.channel = CASE s.step_type::text
              WHEN 'sms' THEN 'sms'
              WHEN 'email' THEN 'email'
              WHEN 'voice' THEN 'call'
            END
        )
      ORDER BY e.next_run_at, e.created_at, e.id
      LIMIT p.max_items
      FOR UPDATE OF e SKIP LOCKED
    ) c
  ),
  candidates AS (
    SELECT * FROM express_candidates
    UNION ALL
    SELECT * FROM regular_candidates
  ),
  picked AS (
    -- Round-robin across tenants; inside each tenant express items come first.
    SELECT ranked.id, ranked.step_type
    FROM (
      SELECT
        candidates.id,
        candidates.step_type,
        candidates.express,
        candidates.next_run_at,
        row_number() OVER (
          PARTITION BY candidates.tenant_id
          ORDER BY candidates.express DESC, candidates.next_run_at, candidates.created_at, candidates.id
        ) AS rn
      FROM candidates
    ) ranked
    ORDER BY ranked.rn, ranked.express DESC, ranked.next_run_at, ranked.id
    LIMIT (SELECT max_items FROM params)
  )
  UPDATE public.journey_enrollments e
  SET claimed_at = now(),
      claimed_by = p.worker,
      lease_expires_at = now() + p.lease
  FROM picked, params p
  WHERE e.id = picked.id
  RETURNING e.id, e.tenant_id, e.lease_expires_at, picked.step_type;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) TO service_role;

-- base: 20261015110000_journey_dispatch_leases_fairness_rate_limits.sql
-- Backward-compatible signature used by the previous app version. The leased
-- claim above already skips demo tenants; the filter here is a second guard.
CREATE OR REPLACE FUNCTION public.claim_due_journey_enrollments(
  p_limit integer,
  p_tenant_ids uuid[],
  p_journey_ids uuid[]
)
RETURNS TABLE (id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id
  FROM public.claim_journey_enrollments_leased(
    p_limit, 'journey-dispatcher', 600, p_tenant_ids, p_journey_ids
  ) c
  WHERE NOT public.is_demo_tenant(c.tenant_id);
$$;

REVOKE ALL ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[]) TO service_role;

-- base: 20261014125000_add_journey_worker_canary_filters.sql
CREATE OR REPLACE FUNCTION public.claim_journey_scan_jobs(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer,
  p_tenant_ids uuid[],
  p_journey_ids uuid[]
)
RETURNS SETOF public.journey_scan_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_journey_scan_jobs();

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM public.journey_scan_jobs job
    JOIN public.journeys journey ON journey.id = job.journey_id
    WHERE journey.status = 'active'
      AND (coalesce(cardinality(p_tenant_ids), 0) = 0 OR job.tenant_id = ANY(p_tenant_ids))
      AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR job.journey_id = ANY(p_journey_ids))
      AND (
        (job.status IN ('queued', 'retry') AND job.next_run_at <= now())
        OR (job.status = 'running' AND job.lease_expires_at < now())
      )
      AND NOT public.is_demo_tenant(job.tenant_id)
    ORDER BY job.next_run_at, job.updated_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 3), 20))
  )
  UPDATE public.journey_scan_jobs job
  SET status = 'running',
      lease_owner = coalesce(nullif(p_worker_id, ''), gen_random_uuid()::text),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))),
      attempt_count = job.attempt_count + 1,
      last_started_at = now(),
      last_error = null
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer, uuid[], uuid[])
  TO service_role;

-- base: 20261015130000_level_transition_outbox.sql
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
        AND NOT public.is_demo_tenant(o.tenant_id)
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

-- ---------------------------------------------------------------------------
-- 4. Meta sync queue
--    base: 20261002143000_meta_sync_queue.sql
-- ---------------------------------------------------------------------------
create or replace function public.claim_meta_sync_jobs(
  p_limit integer default 2,
  p_worker_id text default null
)
returns setof public.meta_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select job.id
    from public.meta_sync_jobs job
    where (
      (job.status in ('queued', 'retry') and job.next_attempt_at <= now())
      or (job.status = 'running' and job.locked_at < now() - interval '10 minutes')
    )
      and job.attempt_count < job.max_attempts
      and not public.is_demo_tenant(job.tenant_id)
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 2), 10))
  )
  update public.meta_sync_jobs job
  set status = 'running',
      attempt_count = job.attempt_count + 1,
      locked_at = now(),
      worker_id = coalesce(p_worker_id, gen_random_uuid()::text),
      started_at = coalesce(job.started_at, now()),
      last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

revoke execute on function public.claim_meta_sync_jobs(integer, text) from public, anon, authenticated;
grant execute on function public.claim_meta_sync_jobs(integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Webhook replay (tenant loop skips demo tenants, dry-run included)
--    base: 20261015092000_webhook_replay_backoff_dlq.sql
-- ---------------------------------------------------------------------------
create or replace function public.claim_webhook_logs_for_replay(
  p_limit integer default 20,
  p_min_age interval default interval '2 minutes',
  p_per_tenant integer default null,
  p_tenant_id uuid default null,
  p_evento text default null,
  p_statuses text[] default array['recebido', 'erro'],
  p_max_attempts integer default 8,
  p_dry_run boolean default false
)
returns table (
  id uuid,
  tenant_id uuid,
  evento text,
  payload jsonb,
  replay_attempts integer,
  action text
)
language plpgsql
security definer
set search_path = public, pg_temp
-- Plano sempre customizado: com p_statuses/p_evento constantes o planner
-- consegue provar o predicado do índice parcial.
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_per_tenant integer;
  v_max_attempts integer := greatest(coalesce(p_max_attempts, 8), 1);
  v_min_age interval := coalesce(p_min_age, interval '2 minutes');
  v_statuses text[] := coalesce(p_statuses, array['recebido', 'erro']);
begin
  v_per_tenant := least(greatest(coalesce(p_per_tenant, v_limit), 1), v_limit);

  if p_dry_run then
    return query
    with ranked as (
      select c.*, row_number() over (
        partition by c.tenant_id order by c.next_replay_at, c.created_at
      ) as rn
      from public.tenants t
      cross join lateral (
        select w.id, w.tenant_id, w.evento, w.replay_attempts, w.next_replay_at, w.created_at
        from public.webhook_logs w
        where w.tenant_id = t.id
          and w.status = any (v_statuses)
          and w.dead_lettered_at is null
          and w.next_replay_at <= now()
          and w.created_at < now() - v_min_age
          and (p_evento is null or w.evento = p_evento)
        order by w.next_replay_at, w.created_at
        limit v_per_tenant
      ) c
      where (p_tenant_id is null or t.id = p_tenant_id)
        and not t.is_demo
    )
    select r.id, r.tenant_id, r.evento, null::jsonb, r.replay_attempts,
           case when r.replay_attempts >= v_max_attempts then 'would_dead_letter' else 'candidate' end
    from ranked r
    order by r.rn, r.next_replay_at, r.created_at
    limit v_limit;
    return;
  end if;

  return query
  with locked as (
    select c.id, c.tenant_id, c.replay_attempts, c.next_replay_at, c.created_at
    from public.tenants t
    cross join lateral (
      select w.id, w.tenant_id, w.replay_attempts, w.next_replay_at, w.created_at
      from public.webhook_logs w
      where w.tenant_id = t.id
        and w.status = any (v_statuses)
        and w.dead_lettered_at is null
        and w.next_replay_at <= now()
        and w.created_at < now() - v_min_age
        and (p_evento is null or w.evento = p_evento)
      order by w.next_replay_at, w.created_at
      limit v_per_tenant
      for update of w skip locked
    ) c
    where (p_tenant_id is null or t.id = p_tenant_id)
      and not t.is_demo
  ),
  picked as (
    select l.*
    from (
      select l0.*, row_number() over (
        partition by l0.tenant_id order by l0.next_replay_at, l0.created_at
      ) as rn
      from locked l0
    ) l
    order by l.rn, l.next_replay_at, l.created_at
    limit v_limit
  ),
  updated as (
    update public.webhook_logs w
       set replay_attempts = case
             when p.replay_attempts >= v_max_attempts then w.replay_attempts
             else w.replay_attempts + 1
           end,
           next_replay_at = case
             when p.replay_attempts >= v_max_attempts then w.next_replay_at
             else now() + least(power(2, w.replay_attempts + 1), 60) * interval '1 minute'
           end,
           dead_lettered_at = case
             when p.replay_attempts >= v_max_attempts then now()
             else w.dead_lettered_at
           end,
           last_replay_error = case
             when p.replay_attempts >= v_max_attempts
               then coalesce(w.last_replay_error, 'max_replay_attempts_exceeded')
             else w.last_replay_error
           end
      from picked p
     where w.id = p.id
    returning w.id, w.tenant_id, w.evento,
              case when w.dead_lettered_at is null then w.payload else null end as payload,
              w.replay_attempts,
              case when w.dead_lettered_at is null then 'replay' else 'dead_lettered' end as action,
              p.rn, p.next_replay_at as due_at, w.created_at
  )
  select u.id, u.tenant_id, u.evento, u.payload, u.replay_attempts, u.action
  from updated u
  order by u.rn, u.due_at, u.created_at;
end;
$$;

revoke execute on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) from public, anon, authenticated;
grant execute on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) to service_role;

comment on function public.claim_webhook_logs_for_replay(
  integer, interval, integer, uuid, text, text[], integer, boolean
) is
  'CON-03: claim atômico, justo por tenant e com lease/backoff do lote de replay de webhook_logs; DLQ após p_max_attempts.';

-- ---------------------------------------------------------------------------
-- 6. Derived-metric crons (tenant loops skip demo tenants)
-- ---------------------------------------------------------------------------
-- base: 20261015133000_dashboard_refresh_per_tenant.sql
create or replace function public.refresh_recent_dashboard_metrics_slot(
  _slot integer default 0,
  _slots integer default 1
)
returns integer -- tenants that failed or timed out in this slot (-1 = skipped, lock busy)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_tenant_id uuid;
  v_done integer := 0;
  v_failed integer := 0;
  v_timed_out boolean := false;
  v_last_error text;
  v_seen integer := 0;
  v_single_tenant uuid;
begin
  if _slots is null or _slots < 1 or _slot is null or _slot < 0 or _slot >= _slots then
    raise exception 'invalid slot % of %', _slot, _slots;
  end if;

  -- Same key for every slot: re-entrant inside the run's own transaction
  -- (advisory locks are per session), busy for any other session.
  if not pg_try_advisory_xact_lock(hashtext('betleads.refresh_recent_dashboard_metrics')::bigint) then
    raise notice 'refresh_recent_dashboard_metrics: another run holds the lock; skipping slot %', _slot;
    return -1;
  end if;

  -- Fail fast instead of queueing behind a long lock on tenant_daily_metrics.
  perform set_config('lock_timeout', '5s', true);

  for v_tenant_id in
    select t.id
    from (
      select id, row_number() over (order by id) - 1 as pos
      from public.tenants
      where not is_demo
    ) t
    where t.pos % _slots = _slot
    order by t.id
  loop
    v_seen := v_seen + 1;
    v_single_tenant := case when v_seen = 1 then v_tenant_id else null end;
    begin
      perform public.refresh_recent_dashboard_metrics_tenant(v_tenant_id);
      v_done := v_done + 1;
    exception
      when query_canceled then
        -- statement_timeout of this slot: tenant rolled back, stop the slot
        -- (the timer does not re-arm inside the statement).
        v_failed := v_failed + 1;
        v_timed_out := true;
        v_last_error := '57014: ' || left(sqlerrm, 200);
        raise warning 'refresh_recent_dashboard_metrics: tenant % timed out', v_tenant_id;
        exit;
      when others then
        v_failed := v_failed + 1;
        v_last_error := sqlstate || ': ' || left(sqlerrm, 200);
        raise warning 'refresh_recent_dashboard_metrics: tenant % failed (%)', v_tenant_id, sqlstate;
    end;
  end loop;

  if v_seen > 0 then
    -- Logging must never undo the refreshed tenants.
    begin
      insert into public.dispatcher_runs (
        channel, kind, job, status, tenant_id, started_at, heartbeat_at, finished_at,
        duration_ms, claimed, sent, errors, stop_reason, last_provider_error
      ) values (
        'dashboard', 'tick', 'dashboard_metrics_refresh',
        case when v_failed = 0 then 'succeeded' when v_done = 0 then 'failed' else 'partial' end,
        v_single_tenant, v_started, clock_timestamp(), clock_timestamp(),
        floor(extract(epoch from clock_timestamp() - v_started) * 1000)::integer,
        v_seen, v_done, v_failed,
        case when v_timed_out then 'timeout' when v_failed > 0 then 'error' else 'done' end,
        v_last_error
      );
    exception when others then
      null;
    end;
  end if;

  return v_failed;
end;
$$;

revoke all on function public.refresh_recent_dashboard_metrics_slot(integer, integer) from public, anon, authenticated;
grant execute on function public.refresh_recent_dashboard_metrics_slot(integer, integer) to service_role;

-- base: 20261016180000_player_lifecycle_daily.sql
create or replace function public.refresh_crm_results_recent(_days integer default 2)
returns integer -- tenants that failed (-1 = skipped, another run holds the lock)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_tenant uuid;
  v_day date;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.refresh_crm_results')::bigint) then
    return -1;
  end if;
  for v_tenant in select id from public.tenants where not is_demo order by id loop
    begin
      for v_day in
        select generate_series(v_today - greatest(1, _days) + 1, v_today, interval '1 day')::date
      loop
        perform public.refresh_crm_results_day(v_tenant, v_day);
        perform public.refresh_player_lifecycle_day(v_tenant, v_day);
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'refresh_crm_results: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  return v_failed;
end;
$$;

revoke all on function public.refresh_crm_results_recent(integer) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_recent(integer) to service_role;

-- base: 20261016190000_crm_results_health.sql
create or replace function public.check_crm_results_recent()
returns integer -- failed checks across tenants (-1 = another run holds the lock)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'America/Sao_Paulo')::date - 1;
  v_tenant uuid;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.check_crm_results')::bigint) then
    return -1;
  end if;
  for v_tenant in select id from public.tenants where not is_demo order by id loop
    begin
      v_failed := v_failed + public.check_crm_results_day(v_tenant, v_day);
    exception when others then
      raise warning 'check_crm_results: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  if v_failed > 0 then
    raise warning 'check_crm_results: % failed check(s) for %', v_failed, v_day;
  end if;
  return v_failed;
end;
$$;

revoke all on function public.check_crm_results_recent() from public, anon, authenticated;
grant execute on function public.check_crm_results_recent() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Per-tenant orchestrator cron: never posts for a demo tenant.
--    base: 20261003143000_enable_validated_automation_crons.sql
-- ---------------------------------------------------------------------------
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-orchestrate-tenants'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule('betleads-orchestrate-tenants', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://betleads.io/api/public/hooks/orchestrate?tenant=' || t.id::text,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)),
    body := '{}'::jsonb
  )
  from public.tenants t
  where not t.is_demo;
$job$);

notify pgrst, 'reload schema';
