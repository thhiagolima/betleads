-- Canary-aware claims. Empty arrays mean no filter only after the application
-- explicitly accepts global operation; the application otherwise fails closed.
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

CREATE OR REPLACE FUNCTION public.claim_due_journey_enrollments(
  p_limit integer,
  p_tenant_ids uuid[],
  p_journey_ids uuid[]
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT enrollment.id
    FROM public.journey_enrollments enrollment
    JOIN public.journeys journey ON journey.id = enrollment.journey_id
    WHERE enrollment.status IN ('active', 'waiting')
      AND enrollment.next_run_at <= now()
      AND journey.status = 'active'
      AND (enrollment.claimed_at IS NULL OR enrollment.claimed_at < now() - interval '10 minutes')
      AND (coalesce(cardinality(p_tenant_ids), 0) = 0 OR enrollment.tenant_id = ANY(p_tenant_ids))
      AND (coalesce(cardinality(p_journey_ids), 0) = 0 OR enrollment.journey_id = ANY(p_journey_ids))
    ORDER BY enrollment.next_run_at, enrollment.created_at
    FOR UPDATE OF enrollment SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  )
  UPDATE public.journey_enrollments enrollment
  SET claimed_at = now(), claimed_by = 'journey-dispatcher'
  FROM candidates
  WHERE enrollment.id = candidates.id
  RETURNING enrollment.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_scan_jobs(integer, text, integer, uuid[], uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[])
  TO service_role;
