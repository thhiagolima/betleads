-- SA-02 (docs/AUDITORIA_SISTEMA_2026-11-19.md §3): the workers' claims skip
-- suspended/canceled houses and ended journeys.
--
-- Before this, a house with tenants.status 'suspended' or 'canceled' still had
-- its scheduled SMS/e-mail campaigns and its journey steps claimed (and, for
-- e-mail, voice, WhatsApp and push, sent), and a journey past its ends_at (D-4)
-- kept running steps until the next exit sweep moved its enrollments out.
--
-- Each function below is the LATEST definition (20261018110000, lexical
-- order) copied verbatim; the only additions are:
--   * claim_due_email_campaigns / claim_due_sms_campaigns: the campaign's
--     tenant must not be 'suspended'/'canceled' (a null/unknown tenant keeps
--     the previous behaviour);
--   * claim_journey_enrollments_leased: tenant_scope drops 'suspended' and
--     'canceled' tenants, and both the express and the regular candidates
--     require (ends_at IS NULL OR ends_at > now()). Open enrollments of an
--     ended journey are still exited as `journey_ended` by sweep_journey_exits;
--     a suspended house's items stay where they are and resume if the house
--     is reactivated (time-sensitive steps still exit as stale_message).
-- Signatures, return types, SECURITY DEFINER, search_path and the
-- REVOKE/GRANT lines are unchanged (repeated as they were).
--
-- Additive and idempotent (CREATE OR REPLACE only, no schema change). Apply it
-- before or together with the app deploy that adds the TenantSuspendedError
-- send guard (the app also refuses these sends on its own; this keeps the
-- workers from claiming them at all). claim_due_journey_enrollments (legacy
-- wrapper) calls claim_journey_enrollments_leased and inherits the filters.

-- ---------------------------------------------------------------------------
-- 1. E-mail campaigns
--    base: 20261018110000_demo_tenant_skip_workers.sql
-- ---------------------------------------------------------------------------
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
         -- SA-02: a suspended/canceled house sends nothing.
         AND NOT EXISTS (
           SELECT 1 FROM public.tenants t
            WHERE t.id = ec.tenant_id AND t.status IN ('suspended', 'canceled')
         )
       ORDER BY ec.scheduled_at ASC
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ) picked
   WHERE c.id = picked.id
  RETURNING c.*;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_email_campaigns(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. SMS campaigns
--    base: 20261018110000_demo_tenant_skip_workers.sql
-- ---------------------------------------------------------------------------
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
         -- SA-02: a suspended/canceled house sends nothing.
         AND NOT EXISTS (
           SELECT 1 FROM public.tenants t
            WHERE t.id = sc.tenant_id AND t.status IN ('suspended', 'canceled')
         )
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
-- 3. Journeys
--    base: 20261018110000_demo_tenant_skip_workers.sql
-- ---------------------------------------------------------------------------
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
      -- SA-02: a suspended/canceled house sends nothing.
      AND t.status NOT IN ('suspended', 'canceled')
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
            -- SA-02: a journey past its end date (D-4) sends nothing more.
            AND (xj.ends_at IS NULL OR xj.ends_at > now())
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
        -- SA-02: a journey past its end date (D-4) sends nothing more.
        AND (j.ends_at IS NULL OR j.ends_at > now())
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
