-- OBS-04 / OBS-05 — real job heartbeats and queue metrics.
--
-- 1) dispatcher_runs gains start/progress/end tracking: a run is inserted with
--    status='running' when the worker starts, heartbeat_at is refreshed while it
--    works and status/finished_at are set at the end. A killed or hung worker
--    leaves a 'running' row whose heartbeat stops moving (= stale).
-- 2) observability_job_health(): one row per job — "is the worker alive?".
-- 3) observability_queue_metrics(): one row per tenant x channel for journeys —
--    "which tenant is late?".
--
-- Additive only. Existing inserts keep working: every new column is nullable
-- and has no default (no table rewrite; legacy rows keep NULL and are treated
-- as finished runs). Both new indexes are partial and start out empty/small,
-- but building them still scans dispatcher_runs while holding the ALTER lock
-- for the whole transaction: apply off-peak.
--
-- The RPCs do not set statement_timeout: a function-level SET does not bound
-- the calling statement. Callers must apply their own timeout; both functions
-- are meant for on-demand diagnostics, not for a cron.
-- Fail fast instead of queueing behind a long lock on the live log table.
SET lock_timeout = '5s';

-- ============================================================
-- 1) dispatcher_runs: lifecycle columns
-- ============================================================
ALTER TABLE public.dispatcher_runs
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS job text,
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- Already nullable since creation; kept explicit because 'running' rows rely on it.
ALTER TABLE public.dispatcher_runs ALTER COLUMN finished_at DROP NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.dispatcher_runs
    ADD CONSTRAINT dispatcher_runs_status_check
    CHECK (status IS NULL OR status IN ('running', 'succeeded', 'failed', 'partial'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.dispatcher_runs.status IS
  'running | succeeded | failed | partial. NULL = legacy row written only at the end of a run.';
COMMENT ON COLUMN public.dispatcher_runs.heartbeat_at IS
  'Last progress write by the worker. A running row with an old heartbeat is a hung/killed worker.';
COMMENT ON COLUMN public.dispatcher_runs.job IS
  'Logical job name (journey_dispatch, journey_scan, sms_campaign_dispatch, webhook_replay, shortio_sync, recovery, sms_tick, ...).';
COMMENT ON COLUMN public.dispatcher_runs.tenant_id IS
  'Tenant when the run is tenant-scoped; NULL for global runs. No FK on purpose (log table).';

CREATE INDEX IF NOT EXISTS dispatcher_runs_running_heartbeat_idx
  ON public.dispatcher_runs (status, heartbeat_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS dispatcher_runs_job_started_idx
  ON public.dispatcher_runs (job, started_at DESC)
  WHERE job IS NOT NULL;

-- RLS is unchanged: service_role writes (bypasses RLS), super_admin reads.

-- ============================================================
-- 2) observability_job_health()
-- ============================================================
-- One row per job seen in dispatcher_runs (rows with job IS NOT NULL).
-- Uses a loose index scan over dispatcher_runs_job_started_idx to list jobs and
-- index-bounded lookups per job, so the cost does not grow with history.
CREATE OR REPLACE FUNCTION public.observability_job_health()
RETURNS TABLE (
  job text,
  last_started_at timestamptz,
  last_status text,
  last_stop_reason text,
  last_finished_at timestamptz,
  last_finished_status text,
  seconds_since_last_start integer,
  running integer,
  stale_running integer,
  oldest_running_heartbeat_at timestamptz,
  runs_last_hour integer,
  failed_last_hour integer,
  partial_last_hour integer
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE jobs(job) AS (
    (
      SELECT r.job
      FROM public.dispatcher_runs r
      WHERE r.job IS NOT NULL
      ORDER BY r.job
      LIMIT 1
    )
    UNION ALL
    SELECT (
      SELECT r.job
      FROM public.dispatcher_runs r
      WHERE r.job IS NOT NULL AND r.job > jobs.job
      ORDER BY r.job
      LIMIT 1
    )
    FROM jobs
    WHERE jobs.job IS NOT NULL
  )
  SELECT
    j.job,
    last_run.started_at,
    coalesce(last_run.status, CASE WHEN last_run.finished_at IS NOT NULL THEN 'succeeded' END),
    last_run.stop_reason,
    last_done.finished_at,
    coalesce(last_done.status, 'succeeded'),
    floor(extract(epoch FROM now() - last_run.started_at))::integer,
    coalesce(live.running, 0)::integer,
    coalesce(live.stale, 0)::integer,
    live.oldest_heartbeat,
    coalesce(hour.runs, 0)::integer,
    coalesce(hour.failed, 0)::integer,
    coalesce(hour.partial, 0)::integer
  FROM jobs j
  CROSS JOIN LATERAL (
    SELECT r.started_at, r.finished_at, r.status, r.stop_reason
    FROM public.dispatcher_runs r
    WHERE r.job = j.job
    ORDER BY r.started_at DESC
    LIMIT 1
  ) last_run
  LEFT JOIN LATERAL (
    SELECT r.finished_at, r.status
    FROM public.dispatcher_runs r
    WHERE r.job = j.job
      AND r.started_at >= now() - interval '7 days'
      AND r.finished_at IS NOT NULL
    ORDER BY r.started_at DESC
    LIMIT 1
  ) last_done ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS running,
      -- Older than 2 min without progress = hung/killed. Rows older than
      -- 24 h are ignored here (they are reaped by the next start of the job).
      count(*) FILTER (
        WHERE r.heartbeat_at < now() - interval '2 minutes'
          AND r.started_at >= now() - interval '24 hours'
      ) AS stale,
      min(r.heartbeat_at) AS oldest_heartbeat
    FROM public.dispatcher_runs r
    WHERE r.status = 'running'
      AND r.job = j.job
  ) live ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS runs,
      count(*) FILTER (WHERE r.status = 'failed') AS failed,
      count(*) FILTER (WHERE r.status = 'partial') AS partial
    FROM public.dispatcher_runs r
    WHERE r.job = j.job
      AND r.started_at >= now() - interval '1 hour'
  ) hour ON true
  WHERE j.job IS NOT NULL
  ORDER BY j.job;
$$;

COMMENT ON FUNCTION public.observability_job_health() IS
  'OBS-05: per job — last start/finish/status, running and stale (heartbeat > 2 min) runs, runs/failures in the last hour.';

-- ============================================================
-- 3) observability_queue_metrics()
-- ============================================================
-- Journeys queue per tenant x channel. channel = step_type of the step at the
-- enrollment's current position ('none' when past the last step).
--   ready            due now, active/waiting, journey active, not claimed
--   future           active/waiting with next_run_at in the future
--   paused           enrollment paused / paused_by_priority
--   retrying         waiting with attempts > 0 (overlaps ready/future)
--   claimed          claimed by a dispatcher in the last 10 min (in flight)
--   journey_inactive due but the journey itself is not active
--   oldest_ready_age_seconds / ready_age_p95_seconds  age of the ready backlog
--   sent_15m / errors_15m  journey_step_executions created in the last 15 min
-- Index use: journey_enrollments_ready_idx (active/waiting),
-- journey_enrollments_tenant_journey_idx (paused, per journey),
-- journey_step_executions_daily_reservation_idx (sent, per journey x channel),
-- journey_step_executions_tenant_journey_status_idx (errors, per journey).
CREATE OR REPLACE FUNCTION public.observability_queue_metrics()
RETURNS TABLE (
  tenant_id uuid,
  channel text,
  ready bigint,
  future bigint,
  paused bigint,
  retrying bigint,
  claimed bigint,
  journey_inactive bigint,
  oldest_ready_age_seconds integer,
  ready_age_p95_seconds integer,
  sent_15m bigint,
  errors_15m bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH live AS (
    SELECT
      e.tenant_id,
      coalesce(st.step_type::text, 'none') AS channel,
      e.status::text AS status,
      e.next_run_at,
      e.claimed_at,
      e.attempts,
      j.status::text AS journey_status,
      (
        e.next_run_at <= now()
        AND j.status = 'active'
        AND (e.claimed_at IS NULL OR e.claimed_at < now() - interval '10 minutes')
      ) AS is_ready
    FROM public.journey_enrollments e
    JOIN public.journeys j ON j.id = e.journey_id
    LEFT JOIN public.journey_steps st
      ON st.journey_id = e.journey_id
     AND st.position = e.current_position
    WHERE e.status IN ('active', 'waiting')
  ),
  live_agg AS (
    SELECT
      l.tenant_id,
      l.channel,
      count(*) FILTER (WHERE l.is_ready) AS ready,
      count(*) FILTER (WHERE l.next_run_at > now()) AS future,
      count(*) FILTER (WHERE l.status = 'waiting' AND l.attempts > 0) AS retrying,
      count(*) FILTER (WHERE l.claimed_at >= now() - interval '10 minutes') AS claimed,
      count(*) FILTER (WHERE l.next_run_at <= now() AND l.journey_status <> 'active')
        AS journey_inactive,
      floor(extract(epoch FROM now() - min(l.next_run_at) FILTER (WHERE l.is_ready)))::integer
        AS oldest_ready_age_seconds,
      floor(
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM now() - l.next_run_at))
          FILTER (WHERE l.is_ready)
      )::integer AS ready_age_p95_seconds
    FROM live l
    GROUP BY l.tenant_id, l.channel
  ),
  paused_agg AS (
    SELECT
      e.tenant_id,
      coalesce(st.step_type::text, 'none') AS channel,
      count(*) AS paused
    FROM public.journeys j
    JOIN public.journey_enrollments e
      ON e.tenant_id = j.tenant_id
     AND e.journey_id = j.id
     AND e.status IN ('paused', 'paused_by_priority')
    LEFT JOIN public.journey_steps st
      ON st.journey_id = e.journey_id
     AND st.position = e.current_position
    GROUP BY e.tenant_id, coalesce(st.step_type::text, 'none')
  ),
  pairs AS (
    SELECT DISTINCT s.tenant_id, s.journey_id, s.step_type::text AS channel
    FROM public.journey_steps s
    JOIN public.journeys j ON j.id = s.journey_id
    WHERE j.status IN ('active', 'paused')
      AND s.step_type::text IN ('sms', 'email', 'voice')
  ),
  exec_agg AS (
    SELECT
      p.tenant_id,
      p.channel,
      sum(x.sent) AS sent_15m,
      sum(x.errors) AS errors_15m
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT
        (
          SELECT count(*)
          FROM public.journey_step_executions x
          WHERE x.tenant_id = p.tenant_id
            AND x.journey_id = p.journey_id
            AND x.channel = p.channel
            AND x.status IN ('sent', 'delivered')
            AND x.created_at >= now() - interval '15 minutes'
        ) AS sent,
        (
          SELECT count(*)
          FROM public.journey_step_executions x
          WHERE x.tenant_id = p.tenant_id
            AND x.journey_id = p.journey_id
            AND x.status IN ('failed', 'retrying')
            AND x.channel = p.channel
            AND x.created_at >= now() - interval '15 minutes'
        ) AS errors
    ) x
    GROUP BY p.tenant_id, p.channel
  ),
  keys AS (
    SELECT la.tenant_id, la.channel FROM live_agg la
    UNION
    SELECT pa.tenant_id, pa.channel FROM paused_agg pa
    UNION
    SELECT ea.tenant_id, ea.channel FROM exec_agg ea
  )
  SELECT
    k.tenant_id,
    k.channel,
    coalesce(la.ready, 0),
    coalesce(la.future, 0),
    coalesce(pa.paused, 0),
    coalesce(la.retrying, 0),
    coalesce(la.claimed, 0),
    coalesce(la.journey_inactive, 0),
    la.oldest_ready_age_seconds,
    la.ready_age_p95_seconds,
    coalesce(ea.sent_15m, 0)::bigint,
    coalesce(ea.errors_15m, 0)::bigint
  FROM keys k
  LEFT JOIN live_agg la ON la.tenant_id = k.tenant_id AND la.channel = k.channel
  LEFT JOIN paused_agg pa ON pa.tenant_id = k.tenant_id AND pa.channel = k.channel
  LEFT JOIN exec_agg ea ON ea.tenant_id = k.tenant_id AND ea.channel = k.channel
  ORDER BY la.oldest_ready_age_seconds DESC NULLS LAST, k.tenant_id, k.channel;
$$;

COMMENT ON FUNCTION public.observability_queue_metrics() IS
  'OBS-05: journeys queue per tenant x channel — ready/future/paused/retrying/claimed, ready age (oldest, p95), sent/errors in the last 15 min.';

-- ============================================================
-- 4) Grants: service_role only
-- ============================================================
REVOKE ALL ON FUNCTION public.observability_job_health() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.observability_queue_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observability_job_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.observability_queue_metrics() TO service_role;

RESET lock_timeout;
