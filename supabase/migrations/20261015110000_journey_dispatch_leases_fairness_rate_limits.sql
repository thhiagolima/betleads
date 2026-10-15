-- ENV-01 / ENV-05 / ENV-04 (journeys) — explicit leases, worker slots, per-tenant
-- fair claim and DB-backed channel rate limits.
-- Scope: docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md (Fase C, seção 5).
--
-- WHAT CHANGES
-- 1. journey_enrollments.lease_expires_at (claimed_by already exists). An item
--    is claimable when it is not claimed, or its lease expired:
--      claimed_at IS NULL
--      OR coalesce(lease_expires_at, claimed_at + 10 min) < now()
--    Rows claimed by pre-ENV-01 code (no lease) keep the old 10-minute rule;
--    rows released by old code (claimed_at := NULL, lease left behind) are
--    immediately claimable again.
-- 2. claim_journey_enrollments_leased(): round-robin across tenants
--    (row_number() per tenant, LATERAL ... LIMIT per tenant) so a tenant with a
--    10k backlog cannot starve a tenant with 100 items; canary filters from
--    20261014125000 kept; channels paused in dispatch_pause_state are skipped.
--    It also returns the current step type and accepts p_exclude
--    ('<tenant_id>:<step_type>' pairs whose channel budget is exhausted): the
--    worker stops claiming those until the bucket refills instead of
--    re-claiming and re-deferring them (QA I2).
-- 3. Worker slots (journey_dispatcher_slots): at most N dispatcher runs hold a
--    slot; the others exit with stop_reason 'busy'. A lease row is used instead
--    of a session advisory lock because the app talks to Postgres through
--    PostgREST (transaction pooling: session locks would leak or be lost).
-- 4. Lease renewal / release RPCs, lease-aware recover_orphaned_journey_claims().
-- 5. channel_rate_limits + channel_budget_buckets (token bucket) +
--    channel_concurrency_permits (semaphore with TTL); consume_channel_budget(),
--    acquire_channel_slot(), release_channel_slot().
--
-- DEPLOY COMPATIBILITY (old app running against this schema for a few minutes)
-- * All columns/tables are additive; no existing column is changed.
-- * claim_due_journey_enrollments(integer, uuid[], uuid[]) keeps its signature
--   and return type. It now delegates to the fair, lease-aware claim with a
--   600 s lease (same as the old implicit 10-minute rule) and claimed_by
--   'journey-dispatcher', so old and new workers never pick the same live item.
-- * recover_orphaned_journey_claims() keeps its signature; it now releases
--   only claims whose lease expired (it used to release live items of a worker
--   still waiting for its wave -> duplicate sends).
-- * Old code's release (claimed_at := NULL, claimed_by := NULL) leaves
--   lease_expires_at behind; the predicate treats claimed_at IS NULL as free.
-- * Deploy order: apply this migration BEFORE the new app version (the new
--   dispatcher calls the RPCs created here).
-- * New behavior for old code too: journey items whose current step channel is
--   paused in dispatch_pause_state (sms/email/call per tenant) are not claimed.
--
-- LOCKS / COST (production read-only check 2026-10-15: journey_enrollments
-- ~48.7k rows, 19 MB heap, 38 MB total; ~41k rows in active/waiting)
-- * ADD COLUMN (nullable, no default): catalog-only, ACCESS EXCLUSIVE for
--   milliseconds. lock_timeout makes it fail fast instead of queueing writers.
-- * CREATE INDEX (not CONCURRENTLY: migrations run in a transaction): SHARE lock
--   (blocks writes to journey_enrollments, not reads) while ~41k partial rows
--   are indexed: well under one second at this size. If preferred, run the
--   CREATE INDEX CONCURRENTLY statement below by hand first; IF NOT EXISTS
--   makes the step here a no-op.
-- * New tables are empty or tiny (seed: 7 rows).
--
-- ROLLBACK (manual): the app can be rolled back without reverting this file;
-- old code works against this schema. To revert the functions, re-run
-- 20261014125000 (claim) and the recover_orphaned_journey_claims body from
-- 20261007213000. New tables/column may stay.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Lease column + fair-claim index
-- ---------------------------------------------------------------------------
ALTER TABLE public.journey_enrollments
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

COMMENT ON COLUMN public.journey_enrollments.lease_expires_at IS
  'ENV-01: claim lease. Claimable when claimed_at IS NULL or coalesce(lease_expires_at, claimed_at + 10 min) < now(). claimed_by holds the worker run id.';

-- Manual non-blocking alternative (outside a transaction):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_enrollments_tenant_ready_idx
--     ON public.journey_enrollments (tenant_id, next_run_at, created_at)
--     WHERE status IN ('active', 'waiting');
CREATE INDEX IF NOT EXISTS journey_enrollments_tenant_ready_idx
  ON public.journey_enrollments (tenant_id, next_run_at, created_at)
  WHERE status IN ('active', 'waiting');

-- ---------------------------------------------------------------------------
-- 2. Fair, lease-aware claim
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
    WHERE coalesce(cardinality(p_tenant_ids), 0) = 0 OR t.id = ANY(p_tenant_ids)
  ),
  candidates AS (
    -- Per tenant: the oldest due, claimable items (at most max_items each).
    -- Rows are locked here (SKIP LOCKED, re-checked under the lock), so a
    -- concurrent claim skips them and moves on to the next rows instead of
    -- computing the same top-N and coming back empty. Locked-but-not-picked
    -- rows are freed when this statement's transaction ends (milliseconds).
    SELECT c.id, c.tenant_id, c.next_run_at, c.created_at, c.step_type
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
  picked AS (
    -- Round-robin: every tenant's 1st item, then every tenant's 2nd item, ...
    SELECT ranked.id, ranked.step_type
    FROM (
      SELECT
        candidates.id,
        candidates.step_type,
        candidates.next_run_at,
        row_number() OVER (
          PARTITION BY candidates.tenant_id
          ORDER BY candidates.next_run_at, candidates.created_at, candidates.id
        ) AS rn
      FROM candidates
    ) ranked
    ORDER BY ranked.rn, ranked.next_run_at, ranked.id
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

-- Backward-compatible signature used by the previous app version.
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
  ) c;
$$;

-- ---------------------------------------------------------------------------
-- 3. Lease renewal / release / recovery
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_journey_enrollment_claims(
  p_worker_id text,
  p_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.journey_enrollments e
  SET claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL
  WHERE e.id = ANY(coalesce(p_ids, '{}'::uuid[]))
    AND e.claimed_by = p_worker_id
    AND e.claimed_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_orphaned_journey_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.journey_step_executions x
  SET status = 'retrying', error = coalesce(x.error, 'worker_claim_timeout'), completed_at = now()
  WHERE x.status = 'claimed'
    AND x.updated_at < now() - interval '10 minutes'
    AND NOT EXISTS (
      SELECT 1
      FROM public.journey_enrollments e
      WHERE e.id = x.enrollment_id
        AND e.claimed_at IS NOT NULL
        AND coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') >= now()
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.journey_enrollments e
  SET claimed_at = NULL,
      claimed_by = NULL,
      lease_expires_at = NULL,
      status = 'waiting',
      next_run_at = least(e.next_run_at, now())
  WHERE e.claimed_at IS NOT NULL
    AND coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now()
    AND e.status IN ('active', 'waiting');
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Worker slots (mutual exclusion between overlapping cron ticks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journey_dispatcher_slots (
  slot integer PRIMARY KEY CHECK (slot >= 0 AND slot < 64),
  holder text,
  acquired_at timestamptz,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.journey_dispatcher_slots IS
  'ENV-01: at most N journey dispatcher runs hold a slot (lease renewed by the worker). Others exit with stop_reason busy.';

CREATE OR REPLACE FUNCTION public.acquire_journey_dispatcher_slot(
  p_holder text,
  p_max_slots integer,
  p_lease_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max integer := greatest(1, least(coalesce(p_max_slots, 1), 64));
  v_slot integer;
BEGIN
  IF coalesce(p_holder, '') = '' THEN
    RAISE EXCEPTION 'holder is required';
  END IF;
  INSERT INTO public.journey_dispatcher_slots (slot)
  SELECT g FROM generate_series(0, v_max - 1) g
  ON CONFLICT (slot) DO NOTHING;

  UPDATE public.journey_dispatcher_slots s
  SET holder = p_holder,
      acquired_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900))),
      updated_at = now()
  WHERE s.slot = (
    SELECT c.slot
    FROM public.journey_dispatcher_slots c
    WHERE c.slot < v_max
      AND (c.holder IS NULL OR c.lease_expires_at IS NULL OR c.lease_expires_at < now())
    ORDER BY c.slot
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING s.slot INTO v_slot;
  RETURN v_slot;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_journey_dispatcher_slot(p_slot integer, p_holder text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.journey_dispatcher_slots
  SET holder = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE slot = p_slot AND holder = p_holder;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- One heartbeat round trip: renews the worker slot and every item lease the
-- worker still owns. Returns whether the slot is still held and which items
-- were NOT renewed (lease lost: released, finished or taken over).
CREATE OR REPLACE FUNCTION public.renew_journey_dispatch_leases(
  p_worker_id text,
  p_slot integer,
  p_ids uuid[],
  p_lease_seconds integer
)
RETURNS TABLE (slot_held boolean, lost_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease interval := make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)));
  v_slot_rows integer := 0;
  v_renewed uuid[];
BEGIN
  IF p_slot IS NOT NULL THEN
    UPDATE public.journey_dispatcher_slots
    SET lease_expires_at = now() + v_lease, updated_at = now()
    WHERE slot = p_slot AND holder = p_worker_id;
    GET DIAGNOSTICS v_slot_rows = ROW_COUNT;
  END IF;

  WITH renewed AS (
    UPDATE public.journey_enrollments e
    SET lease_expires_at = now() + v_lease
    WHERE e.id = ANY(coalesce(p_ids, '{}'::uuid[]))
      AND e.claimed_by = p_worker_id
      AND e.claimed_at IS NOT NULL
    RETURNING e.id
  )
  SELECT coalesce(array_agg(renewed.id), '{}'::uuid[]) INTO v_renewed FROM renewed;

  RETURN QUERY
  SELECT
    v_slot_rows > 0,
    coalesce(
      (SELECT array_agg(i) FROM unnest(coalesce(p_ids, '{}'::uuid[])) i WHERE NOT (i = ANY(v_renewed))),
      '{}'::uuid[]
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Channel rate limits (ENV-04)
-- ---------------------------------------------------------------------------
-- scope 'global'         : tenant_id NULL, shared by every tenant
-- scope 'tenant_default' : tenant_id NULL, applied to each tenant separately
-- scope 'tenant'         : tenant_id set, overrides tenant_default for it
-- per_second NULL = no rate limit at that scope; max_concurrency NULL = no
-- concurrency limit at that scope. Values are read on every call: edits take
-- effect immediately, without deploy.
CREATE TABLE IF NOT EXISTS public.channel_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  channel text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'tenant_default', 'tenant')),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  per_second numeric CHECK (per_second IS NULL OR per_second > 0),
  burst numeric CHECK (burst IS NULL OR burst >= 1),
  max_concurrency integer CHECK (max_concurrency IS NULL OR max_concurrency > 0),
  concurrency_hold_seconds integer NOT NULL DEFAULT 120
    CHECK (concurrency_hold_seconds BETWEEN 1 AND 3600),
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_rate_limits_scope_tenant_chk CHECK ((scope = 'tenant') = (tenant_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_rate_limits_scope_uidx
  ON public.channel_rate_limits (
    channel, provider, scope, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

COMMENT ON TABLE public.channel_rate_limits IS
  'ENV-04: per-provider/channel limits. scope global|tenant_default (tenant_id NULL) or tenant (override). Burst defaults to max(1, per_second).';

DROP TRIGGER IF EXISTS trg_channel_rate_limits_updated_at ON public.channel_rate_limits;
CREATE TRIGGER trg_channel_rate_limits_updated_at
  BEFORE UPDATE ON public.channel_rate_limits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- burst: tenant SMS holds 3 s of tokens (15) so batched senders (campaign loop,
-- 12 concurrent journey workers) are not starved by per-call refill granularity;
-- the sustained rate is still 5/s per tenant and 15/s global.
-- Voice: the permit is released by the Infobip event callback when the call
-- ends (call_history.provider_response.channel_permit_id); 90 s is only the
-- fallback for a lost callback (ring ~30-45 s + recorded audio).
INSERT INTO public.channel_rate_limits (provider, channel, scope, per_second, burst, max_concurrency, concurrency_hold_seconds, notes)
VALUES
  ('short_brasil', 'sms',     'global',         15,   NULL, NULL, 120, 'Seção 5: 900/min global'),
  ('short_brasil', 'sms',     'tenant_default', 5,    15,   NULL, 120, 'Seção 5: 5 msg/s por tenant (burst 3 s)'),
  ('infobip',      'email',   'global',         10,   NULL, NULL, 120, 'Seção 5'),
  ('infobip',      'email',   'tenant_default', 4,    NULL, NULL, 120, 'Seção 5'),
  ('infobip',      'voice',   'global',         NULL, NULL, 5,    90,  'Seção 5: 5 chamadas simultâneas; permit liberado no callback de fim ou após 90 s'),
  ('infobip',      'voice',   'tenant_default', NULL, NULL, 2,    90,  'Seção 5: 2 simultâneas por tenant'),
  ('shortio',      'shortio', 'global',         40,   NULL, NULL, 120, 'Seção 5: Short.io API (ainda não consumido)')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.channel_budget_buckets (
  scope_key text PRIMARY KEY,
  tokens double precision NOT NULL,
  refilled_at timestamptz NOT NULL
);

COMMENT ON TABLE public.channel_budget_buckets IS
  'ENV-04: token bucket state, one row per scope (<provider>:<channel>:global or <provider>:<channel>:tenant:<uuid>). Internal; edit channel_rate_limits instead.';

CREATE TABLE IF NOT EXISTS public.channel_concurrency_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  channel text NOT NULL,
  tenant_id uuid NOT NULL,
  holder text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS channel_concurrency_permits_scope_idx
  ON public.channel_concurrency_permits (provider, channel, tenant_id, expires_at);

-- Effective limits for (tenant, channel[, provider]).
CREATE OR REPLACE FUNCTION public.channel_rate_limit_for(
  p_tenant_id uuid,
  p_channel text,
  p_provider text DEFAULT NULL
)
RETURNS TABLE (
  provider text,
  global_per_second numeric,
  global_burst numeric,
  global_max_concurrency integer,
  tenant_per_second numeric,
  tenant_burst numeric,
  tenant_max_concurrency integer,
  hold_seconds integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH prov AS (
    SELECT l.provider
    FROM public.channel_rate_limits l
    WHERE l.channel = p_channel AND l.enabled
      AND (p_provider IS NULL OR l.provider = p_provider)
    ORDER BY l.provider
    LIMIT 1
  ),
  g AS (
    SELECT l.* FROM public.channel_rate_limits l, prov
    WHERE l.channel = p_channel AND l.provider = prov.provider AND l.enabled AND l.scope = 'global'
  ),
  t AS (
    SELECT l.* FROM public.channel_rate_limits l, prov
    WHERE l.channel = p_channel AND l.provider = prov.provider AND l.enabled
      AND (l.scope = 'tenant_default' OR (l.scope = 'tenant' AND l.tenant_id = p_tenant_id))
    ORDER BY (l.scope = 'tenant') DESC
    LIMIT 1
  )
  SELECT
    prov.provider,
    (SELECT g.per_second FROM g),
    (SELECT g.burst FROM g),
    (SELECT g.max_concurrency FROM g),
    (SELECT t.per_second FROM t),
    (SELECT t.burst FROM t),
    (SELECT t.max_concurrency FROM t),
    coalesce((SELECT t.concurrency_hold_seconds FROM t), (SELECT g.concurrency_hold_seconds FROM g), 120)
  FROM prov;
$$;

-- Token bucket, enforced across processes. Locks at most two rows (global,
-- then tenant: fixed order, no deadlock) for microseconds. Grants
-- 0..p_n tokens atomically from both scopes. retry_after_ms is the time until
-- the limiting bucket has one token again. No configured limit => granted = p_n.
CREATE OR REPLACE FUNCTION public.consume_channel_budget(
  p_tenant_id uuid,
  p_channel text,
  p_n integer DEFAULT 1,
  p_provider text DEFAULT NULL
)
RETURNS TABLE (granted integer, retry_after_ms integer, limited_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_want integer := greatest(0, least(coalesce(p_n, 1), 1000));
  v_lim record;
  v_keys text[] := '{}';
  v_rates double precision[] := '{}';
  v_caps double precision[] := '{}';
  v_avail double precision[] := '{}';
  v_names text[] := '{}';
  v_times timestamptz[] := '{}';
  v_now timestamptz;
  v_tokens double precision;
  v_refilled timestamptz;
  v_grant double precision;
  v_i integer;
  v_min_i integer;
  v_retry integer := 0;
BEGIN
  IF v_want = 0 THEN
    RETURN QUERY SELECT 0, 0, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_lim FROM public.channel_rate_limit_for(p_tenant_id, p_channel, p_provider);
  IF v_lim.provider IS NULL THEN
    RETURN QUERY SELECT v_want, 0, NULL::text;
    RETURN;
  END IF;

  IF v_lim.global_per_second IS NOT NULL THEN
    v_keys := v_keys || (v_lim.provider || ':' || p_channel || ':global');
    v_rates := v_rates || v_lim.global_per_second::double precision;
    v_caps := v_caps || greatest(1, coalesce(v_lim.global_burst, v_lim.global_per_second))::double precision;
    v_names := v_names || 'global'::text;
  END IF;
  IF v_lim.tenant_per_second IS NOT NULL AND p_tenant_id IS NOT NULL THEN
    v_keys := v_keys || (v_lim.provider || ':' || p_channel || ':tenant:' || p_tenant_id::text);
    v_rates := v_rates || v_lim.tenant_per_second::double precision;
    v_caps := v_caps || greatest(1, coalesce(v_lim.tenant_burst, v_lim.tenant_per_second))::double precision;
    v_names := v_names || 'tenant'::text;
  END IF;
  IF cardinality(v_keys) = 0 THEN
    RETURN QUERY SELECT v_want, 0, NULL::text;
    RETURN;
  END IF;

  -- Lock every bucket (fixed order: global, tenant) and refill it.
  FOR v_i IN 1 .. cardinality(v_keys) LOOP
    INSERT INTO public.channel_budget_buckets (scope_key, tokens, refilled_at)
    VALUES (v_keys[v_i], v_caps[v_i], clock_timestamp())
    ON CONFLICT (scope_key) DO NOTHING;
    SELECT b.tokens, b.refilled_at INTO v_tokens, v_refilled
    FROM public.channel_budget_buckets b
    WHERE b.scope_key = v_keys[v_i]
    FOR UPDATE;
    v_now := clock_timestamp();
    v_times := v_times || v_now;
    v_avail := v_avail || least(
      v_caps[v_i],
      v_tokens + greatest(0, extract(epoch FROM v_now - v_refilled)) * v_rates[v_i]
    );
  END LOOP;

  v_grant := v_want;
  v_min_i := 1;
  FOR v_i IN 1 .. cardinality(v_keys) LOOP
    IF v_avail[v_i] < v_avail[v_min_i] THEN v_min_i := v_i; END IF;
    v_grant := least(v_grant, floor(v_avail[v_i] + 1e-9));
  END LOOP;
  v_grant := greatest(0, v_grant);

  -- refilled_at is the exact instant the refill was computed for: no time
  -- is lost between reading and writing the bucket.
  FOR v_i IN 1 .. cardinality(v_keys) LOOP
    UPDATE public.channel_budget_buckets
    SET tokens = greatest(0, v_avail[v_i] - v_grant), refilled_at = v_times[v_i]
    WHERE scope_key = v_keys[v_i];
  END LOOP;

  IF v_grant < v_want THEN
    -- Time until the most constrained bucket holds one token again.
    v_retry := greatest(
      1,
      ceil(greatest(0, 1 - (v_avail[v_min_i] - v_grant)) / v_rates[v_min_i] * 1000)
    )::integer;
    RETURN QUERY SELECT v_grant::integer, v_retry, v_names[v_min_i];
    RETURN;
  END IF;
  RETURN QUERY SELECT v_grant::integer, 0, NULL::text;
END;
$$;

-- Concurrency semaphore with TTL (voice: a call keeps its permit until it is
-- released or hold_seconds elapse). Serialized per provider/channel with a
-- transaction advisory lock; expired permits are purged on every acquire.
CREATE OR REPLACE FUNCTION public.acquire_channel_slot(
  p_tenant_id uuid,
  p_channel text,
  p_holder text DEFAULT NULL,
  p_hold_seconds integer DEFAULT NULL,
  p_provider text DEFAULT NULL
)
RETURNS TABLE (permit_id uuid, retry_after_ms integer, limited_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lim record;
  v_now timestamptz;
  v_global_used integer;
  v_tenant_used integer;
  v_next timestamptz;
  v_id uuid;
BEGIN
  SELECT * INTO v_lim FROM public.channel_rate_limit_for(p_tenant_id, p_channel, p_provider);
  IF v_lim.provider IS NULL
     OR (v_lim.global_max_concurrency IS NULL AND v_lim.tenant_max_concurrency IS NULL) THEN
    -- Not concurrency limited: grant a no-op permit (NULL id).
    RETURN QUERY SELECT NULL::uuid, 0, NULL::text;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('channel_slot:' || v_lim.provider || ':' || p_channel, 0));
  v_now := clock_timestamp();
  DELETE FROM public.channel_concurrency_permits
  WHERE provider = v_lim.provider AND channel = p_channel AND expires_at <= v_now;

  IF v_lim.global_max_concurrency IS NOT NULL THEN
    SELECT count(*), min(expires_at) INTO v_global_used, v_next
    FROM public.channel_concurrency_permits
    WHERE provider = v_lim.provider AND channel = p_channel;
    IF v_global_used >= v_lim.global_max_concurrency THEN
      RETURN QUERY SELECT NULL::uuid,
        greatest(250, least(60000, ceil(extract(epoch FROM v_next - v_now) * 1000)))::integer,
        'global'::text;
      RETURN;
    END IF;
  END IF;
  IF v_lim.tenant_max_concurrency IS NOT NULL THEN
    SELECT count(*), min(expires_at) INTO v_tenant_used, v_next
    FROM public.channel_concurrency_permits
    WHERE provider = v_lim.provider AND channel = p_channel AND tenant_id = p_tenant_id;
    IF v_tenant_used >= v_lim.tenant_max_concurrency THEN
      RETURN QUERY SELECT NULL::uuid,
        greatest(250, least(60000, ceil(extract(epoch FROM v_next - v_now) * 1000)))::integer,
        'tenant'::text;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.channel_concurrency_permits (provider, channel, tenant_id, holder, acquired_at, expires_at)
  VALUES (
    v_lim.provider, p_channel, p_tenant_id, p_holder, v_now,
    v_now + make_interval(secs => greatest(1, least(coalesce(p_hold_seconds, v_lim.hold_seconds), 3600)))
  )
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 0, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_channel_slot(p_permit_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.channel_concurrency_permits WHERE id = p_permit_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges: worker-only (service_role). RLS on, no policies: only the
--    service role (which bypasses RLS) reads or writes these tables.
-- ---------------------------------------------------------------------------
ALTER TABLE public.journey_dispatcher_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_budget_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_concurrency_permits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.journey_dispatcher_slots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.channel_rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.channel_budget_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.channel_concurrency_permits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.journey_dispatcher_slots TO service_role;
GRANT ALL ON public.channel_rate_limits TO service_role;
GRANT ALL ON public.channel_budget_buckets TO service_role;
GRANT ALL ON public.channel_concurrency_permits TO service_role;

REVOKE ALL ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_journey_enrollment_claims(text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recover_orphaned_journey_claims() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acquire_journey_dispatcher_slot(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_journey_dispatcher_slot(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_journey_dispatch_leases(text, integer, uuid[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.channel_rate_limit_for(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_channel_budget(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acquire_channel_slot(uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_channel_slot(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_journey_enrollments_leased(integer, text, integer, uuid[], uuid[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_journey_enrollments(integer, uuid[], uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_journey_enrollment_claims(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_orphaned_journey_claims() TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_journey_dispatcher_slot(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_journey_dispatcher_slot(integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_journey_dispatch_leases(text, integer, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.channel_rate_limit_for(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_channel_budget(uuid, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_channel_slot(uuid, text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_channel_slot(uuid) TO service_role;

RESET lock_timeout;
