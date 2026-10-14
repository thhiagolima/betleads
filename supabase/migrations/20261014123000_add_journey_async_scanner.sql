-- Persistent, resumable eligibility scans. Scanning is deliberately separate
-- from delivery so a large audience can never starve due journey executions.
CREATE TABLE IF NOT EXISTS public.journey_scan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  journey_version integer NOT NULL CHECK (journey_version > 0),
  mode text NOT NULL DEFAULT 'backfill' CHECK (mode IN ('backfill', 'incremental')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry', 'paused')),
  cursor_player_id uuid,
  cycle_count bigint NOT NULL DEFAULT 0 CHECK (cycle_count >= 0),
  scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  eligible_count bigint NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  enrolled_count bigint NOT NULL DEFAULT 0 CHECK (enrolled_count >= 0),
  duplicate_count bigint NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journey_id, mode)
);

CREATE INDEX IF NOT EXISTS journey_scan_jobs_due_idx
  ON public.journey_scan_jobs (status, next_run_at, created_at)
  WHERE status IN ('queued', 'retry', 'running');
CREATE INDEX IF NOT EXISTS journey_scan_jobs_tenant_journey_idx
  ON public.journey_scan_jobs (tenant_id, journey_id, updated_at DESC);

ALTER TABLE public.journey_scan_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journey_scan_jobs_tenant_read ON public.journey_scan_jobs;
CREATE POLICY journey_scan_jobs_tenant_read
  ON public.journey_scan_jobs FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

GRANT SELECT ON public.journey_scan_jobs TO authenticated;
GRANT ALL ON public.journey_scan_jobs TO service_role;

DROP TRIGGER IF EXISTS journey_scan_jobs_set_updated_at ON public.journey_scan_jobs;
CREATE TRIGGER journey_scan_jobs_set_updated_at
  BEFORE UPDATE ON public.journey_scan_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.sync_journey_scan_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  INSERT INTO public.journey_scan_jobs AS existing (
    tenant_id, journey_id, journey_version, mode, status, next_run_at
  )
  SELECT journey.tenant_id, journey.id, journey.version, 'backfill', 'queued', now()
  FROM public.journeys journey
  WHERE journey.status = 'active'
    AND journey.trigger_type NOT IN ('manual', 'nivel_alterado')
  ON CONFLICT (journey_id, mode) DO UPDATE
  SET tenant_id = EXCLUDED.tenant_id,
      journey_version = EXCLUDED.journey_version,
      status = CASE
        WHEN existing.journey_version <> EXCLUDED.journey_version THEN 'queued'
        WHEN existing.status = 'paused' THEN 'queued'
        ELSE existing.status
      END,
      cursor_player_id = CASE
        WHEN existing.journey_version <> EXCLUDED.journey_version THEN null
        ELSE existing.cursor_player_id
      END,
      next_run_at = CASE
        WHEN existing.journey_version <> EXCLUDED.journey_version THEN now()
        ELSE existing.next_run_at
      END;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.journey_scan_jobs job
  SET status = 'paused', lease_owner = null, lease_expires_at = null
  WHERE job.status <> 'paused'
    AND NOT EXISTS (
      SELECT 1 FROM public.journeys journey
      WHERE journey.id = job.journey_id
        AND journey.tenant_id = job.tenant_id
        AND journey.status = 'active'
        AND journey.trigger_type NOT IN ('manual', 'nivel_alterado')
    );

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_journey_scan_jobs(
  p_limit integer DEFAULT 3,
  p_worker_id text DEFAULT null,
  p_lease_seconds integer DEFAULT 120
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
      AND (
        (job.status IN ('queued', 'retry') AND job.next_run_at <= now())
        OR (job.status = 'running' AND job.lease_expires_at < now())
      )
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

CREATE OR REPLACE FUNCTION public.complete_journey_scan_job_batch(
  p_job_id uuid,
  p_worker_id text,
  p_cursor_player_id uuid,
  p_cycle_complete boolean,
  p_scanned integer,
  p_eligible integer,
  p_enrolled integer,
  p_duplicates integer,
  p_rescan_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.journey_scan_jobs job
  SET status = 'queued',
      cursor_player_id = CASE WHEN p_cycle_complete THEN null ELSE p_cursor_player_id END,
      cycle_count = job.cycle_count + CASE WHEN p_cycle_complete THEN 1 ELSE 0 END,
      scanned_count = job.scanned_count + greatest(coalesce(p_scanned, 0), 0),
      eligible_count = job.eligible_count + greatest(coalesce(p_eligible, 0), 0),
      enrolled_count = job.enrolled_count + greatest(coalesce(p_enrolled, 0), 0),
      duplicate_count = job.duplicate_count + greatest(coalesce(p_duplicates, 0), 0),
      attempt_count = 0,
      next_run_at = CASE
        WHEN p_cycle_complete THEN now() + make_interval(secs => greatest(60, least(coalesce(p_rescan_seconds, 300), 86400)))
        ELSE now()
      END,
      lease_owner = null,
      lease_expires_at = null,
      last_completed_at = CASE WHEN p_cycle_complete THEN now() ELSE job.last_completed_at END,
      last_error = null
  WHERE job.id = p_job_id
    AND job.status = 'running'
    AND job.lease_owner = p_worker_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_journey_scan_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.journey_scan_jobs job
  SET status = 'retry',
      next_run_at = now() + make_interval(secs => least(3600, 15 * (2 ^ least(job.attempt_count, 8))::integer)),
      lease_owner = null,
      lease_expires_at = null,
      last_error = left(coalesce(p_error, 'unknown scanner error'), 1000)
  WHERE job.id = p_job_id
    AND job.status = 'running'
    AND job.lease_owner = p_worker_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_journey_scan_jobs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_journey_scan_job_batch(uuid, text, uuid, boolean, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_journey_scan_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_journey_scan_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_journey_scan_job_batch(uuid, text, uuid, boolean, integer, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_journey_scan_job(uuid, text, text) TO service_role;

COMMENT ON TABLE public.journey_scan_jobs IS
  'Resumable per-journey eligibility scans. Delivery workers are independent from this queue.';
