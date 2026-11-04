-- Supabase consumption, P1 (docs/AUDITORIA_CONSUMO_SUPABASE_2026-11-04.md).
--
-- 1. Indexes. link_dispatches had no index on tracked_link_id (the Short.io
--    sync updates by it: ~42k buffers per update); financial_webhook_attempts
--    had none on webhook_log_id, the ON DELETE SET NULL key of webhook_logs.
--    BRIN on the timestamp of append-only logs, for the retention below.
--    Exact duplicates and indexes not used since 02/10 are dropped.
--    On prod these were built/dropped CONCURRENTLY before this file ran, so
--    the statements here are no-ops there.
-- 2. shortio_sync_recent_links: the "links created in the last 24 h" pick
--    walked the house's whole last_synced_at index (317k buffers on pixpgf);
--    filtering by created_at first reads 8.7k.
-- 3. Journey sweeps ran every dispatcher tick: exits now at most once every
--    5 min (the dispatcher re-checks exits before every send, so this is
--    cleanup), dead-lead revivals at most once every 15 min. Demo houses are
--    skipped with a join instead of is_demo_tenant() per row.
-- 4. Nightly retention (decided 2026-11-04): Short.io snapshots keep only the
--    latest per link (the reports read only that) plus 2 days; webhook_logs
--    30 days; financial_webhook_attempts.raw_payload (never read) cleared
--    after 30 days; dispatcher_runs 14 days; link_tracking_sync_runs 7 days;
--    journey_events 90 days. events are not touched.

-- 1. Indexes ---------------------------------------------------------------

create index if not exists link_dispatches_tracked_link_idx
  on public.link_dispatches (tracked_link_id) where tracked_link_id is not null;
create index if not exists financial_webhook_attempts_webhook_log_idx
  on public.financial_webhook_attempts (webhook_log_id) where webhook_log_id is not null;
create index if not exists financial_webhook_attempts_created_brin
  on public.financial_webhook_attempts using brin (created_at);
create index if not exists dispatcher_runs_started_brin
  on public.dispatcher_runs using brin (started_at);
create index if not exists link_tracking_sync_runs_started_brin
  on public.link_tracking_sync_runs using brin (started_at);
create index if not exists journey_events_created_brin
  on public.journey_events using brin (created_at);

-- Same columns and order as deposits_tenant_status_idx / withdrawals_tenant_status_idx.
drop index if exists public.deposits_tenant_status_created_idx;
drop index if exists public.withdrawals_tenant_status_created_idx;
-- (tenant_id, created_at DESC): sms_credit_ledger_tenant_created_idx has the
-- same columns ascending, which a btree reads backwards just as well.
drop index if exists public.idx_sms_credit_ledger_tenant_created;
-- 0 scans since 02/10; sms_send_logs_tenant_flow_player_created_idx covers flows.
drop index if exists public.idx_sms_send_logs_flow_created;
-- 1 scan since 02/10; idx_players_ultimo_login_nulls_last is the one in use.
drop index if exists public.idx_players_ultimo_login;

-- 2. Short.io sync pick ------------------------------------------------------

create or replace function public.shortio_sync_recent_links(
  p_tenant_id uuid,
  p_since timestamptz,
  p_limit integer
)
returns table (id uuid, tenant_id uuid, shortio_link_id text)
language sql
stable
security definer
set search_path = public
as $$
  -- Materialized: otherwise the planner walks the last_synced_at index of
  -- every active link of the house and filters created_at row by row.
  with recent as materialized (
    select l.id, l.tenant_id, l.shortio_link_id, l.last_synced_at, l.created_at
    from public.tracked_links l
    where l.tenant_id = p_tenant_id
      and l.created_at >= p_since
      and l.status = 'active'
  )
  select r.id, r.tenant_id, r.shortio_link_id
  from recent r
  order by r.last_synced_at asc nulls first, r.created_at desc
  limit greatest(0, coalesce(p_limit, 0))
$$;

revoke all on function public.shortio_sync_recent_links(uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.shortio_sync_recent_links(uuid, timestamptz, integer)
  to service_role;

-- 3. Journey sweeps ------------------------------------------------------------

-- Last run of throttled maintenance tasks, shared by every worker.
create table if not exists public.worker_throttle (
  name text primary key,
  last_run_at timestamptz not null
);
alter table public.worker_throttle enable row level security;
revoke all on table public.worker_throttle from public, anon, authenticated;

-- True (and the run is recorded) when `p_name` last ran more than
-- `p_interval` ago; false otherwise. Atomic across concurrent workers, and
-- rolled back with the caller's transaction if the task fails.
create or replace function public.worker_throttle_claim(p_name text, p_interval interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into public.worker_throttle as w (name, last_run_at)
  values (p_name, now())
  on conflict (name) do update
    set last_run_at = excluded.last_run_at
    where w.last_run_at <= now() - p_interval
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.worker_throttle_claim(text, interval) from public, anon, authenticated;
grant execute on function public.worker_throttle_claim(text, interval) to service_role;

-- base: 20261018110000_demo_tenant_skip_workers.sql (throttle + demo join)
CREATE OR REPLACE FUNCTION public.sweep_journey_exits(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Cleanup only (the dispatcher re-checks exits before every send): at
  -- most once every 5 minutes across workers.
  IF NOT public.worker_throttle_claim('sweep_journey_exits', interval '5 minutes') THEN
    RETURN 0;
  END IF;

  WITH phone_journeys AS (
    SELECT j.id FROM public.journeys j WHERE public.journey_requires_phone(j.id)
  ),
  evaluated AS (
    SELECT e.id,
      CASE
        WHEN j.status::text = 'archived' THEN 'journey_archived'
        WHEN j.ends_at IS NOT NULL AND j.ends_at <= now() THEN 'journey_ended'
        WHEN coalesce(j.exit_rules->>'deposit', '') = 'true'
             AND p.ultimo_deposito > e.entered_at THEN 'deposit'
        WHEN coalesce(j.exit_rules->>'first_deposit', '') = 'true'
             AND p.ftd_em > e.entered_at THEN 'first_deposit'
        WHEN coalesce(j.exit_rules->>'login', '') = 'true'
             AND greatest(p.ultimo_login, p.ultimo_jogo) > e.entered_at THEN 'login'
        WHEN coalesce(j.exit_rules->>'voltou_jogar', '') = 'true'
             AND p.ultimo_jogo > e.entered_at THEN 'voltou_jogar'
        WHEN coalesce(j.exit_rules->>'inactivity_over_hours', '') ~ '^[0-9]+(\.[0-9]+)?$'
             AND (CASE coalesce(j.trigger_config->>'field', 'ultimo_deposito')
                    WHEN 'ultimo_login' THEN p.ultimo_login
                    WHEN 'ultimo_jogo' THEN p.ultimo_jogo
                    ELSE p.ultimo_deposito
                  END) <= now() - make_interval(
                    secs => ((j.exit_rules->>'inactivity_over_hours')::numeric * 3600)::double precision)
          THEN 'inactivity_threshold'
        WHEN e.journey_id IN (SELECT id FROM phone_journeys)
             AND coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') = '' THEN 'no_contact'
      END AS reason
    FROM public.journey_enrollments e
    JOIN public.journeys j ON j.id = e.journey_id
    LEFT JOIN public.players p ON p.id = e.player_id
    WHERE e.status IN ('active', 'waiting', 'paused_by_priority')
      -- Never race a worker that holds the item.
      AND (e.claimed_at IS NULL
           OR coalesce(e.lease_expires_at, e.claimed_at + interval '10 minutes') < now())
      -- Demo houses skipped with one join, not a function call per row.
      AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = e.tenant_id AND t.is_demo)
  ),
  picked AS (
    SELECT ev.id, ev.reason
    FROM evaluated ev
    JOIN public.journey_enrollments e ON e.id = ev.id
    WHERE ev.reason IS NOT NULL
    LIMIT greatest(1, coalesce(p_limit, 1000))
    FOR UPDATE OF e SKIP LOCKED
  ),
  exited AS (
    UPDATE public.journey_enrollments e
    SET status = 'exited', exited_at = now(), exit_reason = picked.reason,
        claimed_at = NULL, claimed_by = NULL,
        -- A player without contact may enter again once a phone arrives.
        entry_key = CASE WHEN picked.reason = 'no_contact'
                         THEN left(e.entry_key || ':no_contact:' || e.id::text, 160)
                         ELSE e.entry_key END
    FROM picked
    WHERE e.id = picked.id AND e.status IN ('active', 'waiting', 'paused_by_priority')
    RETURNING e.id, e.tenant_id, e.journey_id, picked.reason
  ),
  logged AS (
    INSERT INTO public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
    SELECT tenant_id, journey_id, id, 'exited',
           jsonb_build_object('reason', reason, 'source', 'exit_sweep')
    FROM exited
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_journey_exits(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_journey_exits(integer) TO service_role;

-- base: 20261117100000_journey_dead_leads.sql (throttle + demo join)
CREATE OR REPLACE FUNCTION public.sweep_dead_lead_revivals(p_tenant_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- The all-houses sweep checks every open dead lead (~25k, four lookups
  -- each): at most once every 15 minutes. A call for one house is not limited.
  IF p_tenant_id IS NULL
     AND NOT public.worker_throttle_claim('sweep_dead_lead_revivals', interval '15 minutes') THEN
    RETURN 0;
  END IF;

  WITH revived AS (
    UPDATE public.journey_dead_leads d
    SET revived_at = now(), revived_reason = 'activity'
    WHERE d.revived_at IS NULL
      AND (p_tenant_id IS NULL OR d.tenant_id = p_tenant_id)
      AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = d.tenant_id AND t.is_demo)
      AND EXISTS (
        SELECT 1
        FROM public.journey_player_last_action(d.tenant_id, d.player_id) a
        WHERE a.action_at > d.marked_at
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM revived;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_dead_lead_revivals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_dead_lead_revivals(uuid) TO service_role;

-- 4. Retention -----------------------------------------------------------------

-- Deletes in batches of p_batch rows until done or p_max_seconds pass, and
-- returns the rows touched per table. Safe to call again: each pass starts
-- from what is left.
create or replace function public.purge_operational_history(
  p_batch integer default 10000,
  p_max_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz :=
    clock_timestamp() + make_interval(secs => greatest(1, coalesce(p_max_seconds, 240)));
  v_batch integer := greatest(100, coalesce(p_batch, 10000));
  v_n integer;
  v_total integer;
  v_links uuid[];
  v_cursor uuid := '00000000-0000-0000-0000-000000000000';
  v_tenant uuid;
  v_out jsonb := '{}'::jsonb;
begin
  -- Short.io snapshots: the reports read only the latest per link. Walks the
  -- (tracked_link_id, snapshot_at) unique index a slice of links at a time.
  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    select array_agg(x.tracked_link_id order by x.tracked_link_id) into v_links
    from (
      select distinct s.tracked_link_id
      from public.link_click_snapshots s
      where s.tracked_link_id > v_cursor
      order by s.tracked_link_id
      limit greatest(100, v_batch / 5)
    ) x;
    exit when v_links is null;
    v_cursor := v_links[array_length(v_links, 1)];
    delete from public.link_click_snapshots o
    where o.tracked_link_id = any (v_links)
      and o.snapshot_at < now() - interval '2 days'
      and exists (
        select 1 from public.link_click_snapshots n
        where n.tracked_link_id = o.tracked_link_id and n.snapshot_at > o.snapshot_at
      );
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  v_out := v_out || jsonb_build_object('link_click_snapshots', v_total);

  -- webhook_logs, 30 days, house by house on (tenant_id, created_at).
  v_total := 0;
  for v_tenant in select t.id from public.tenants t order by t.id loop
    loop
      exit when clock_timestamp() > v_deadline;
      delete from public.webhook_logs w
      where w.ctid = any (array(
        select l.ctid from public.webhook_logs l
        where l.tenant_id = v_tenant and l.created_at < now() - interval '30 days'
        limit v_batch));
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
      exit when v_n < v_batch;
    end loop;
  end loop;
  v_out := v_out || jsonb_build_object('webhook_logs', v_total);

  -- financial_webhook_attempts.raw_payload, 30 days. pg_column_size reads the
  -- stored size, so cleared rows are skipped without fetching any payload.
  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    update public.financial_webhook_attempts f
    set raw_payload = '{}'::jsonb
    where f.ctid = any (array(
      select a.ctid from public.financial_webhook_attempts a
      where a.created_at < now() - interval '30 days'
        and pg_column_size(a.raw_payload) > 8
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('financial_webhook_attempts_payload', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.dispatcher_runs r
    where r.ctid = any (array(
      select d.ctid from public.dispatcher_runs d
      where d.started_at < now() - interval '14 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('dispatcher_runs', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.link_tracking_sync_runs r
    where r.ctid = any (array(
      select d.ctid from public.link_tracking_sync_runs d
      where d.started_at < now() - interval '7 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('link_tracking_sync_runs', v_total);

  v_total := 0;
  loop
    exit when clock_timestamp() > v_deadline;
    delete from public.journey_events e
    where e.ctid = any (array(
      select j.ctid from public.journey_events j
      where j.created_at < now() - interval '90 days'
      limit v_batch));
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n < v_batch;
  end loop;
  v_out := v_out || jsonb_build_object('journey_events', v_total);

  return v_out || jsonb_build_object('finished', clock_timestamp() <= v_deadline);
end;
$$;

revoke all on function public.purge_operational_history(integer, integer)
  from public, anon, authenticated;
grant execute on function public.purge_operational_history(integer, integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job
      where jobname = 'betleads-operational-retention';
    -- 02:50 BRT: after the 00:10 CRM run, before the 03:20 8-day rebuild.
    perform cron.schedule(
      'betleads-operational-retention',
      '50 5 * * *',
      $cron$set statement_timeout = '600s'; select public.purge_operational_history(10000, 480);$cron$
    );
  end if;
end $$;
