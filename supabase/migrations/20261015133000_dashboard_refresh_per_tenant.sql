-- REP-05 — dashboard metrics refresh: per-tenant isolation, per-tenant
-- timeout and no overlapping runs.
--
-- Before (20261014153000): refresh_recent_dashboard_metrics() refreshed
-- yesterday + today for every tenant serially in ONE statement. One slow or
-- failing tenant aborted the whole run (no exception handling), and the
-- function-level `SET statement_timeout = '0'` did not bound or unbound
-- anything: statement_timeout is armed once, when the top-level statement
-- starts. Production evidence (cron.job_run_details, read-only, 2026-10-15):
-- 5 runs failed at ~121 s with "canceling statement due to statement
-- timeout" inside refresh_tenant_daily_metric_day (the session default of the
-- cron role), losing the work of every tenant in the run; healthy runs take
-- ~1.2 s on average (p95 2.9 s, max 13 s) for 6 tenants.
--
-- After:
--  * refresh_recent_dashboard_metrics_tenant(tenant): same work as before for
--    one tenant (yesterday + today, America/Sao_Paulo) — same outputs
--    (tenant_daily_metrics rows written by refresh_tenant_daily_metric_day).
--  * refresh_recent_dashboard_metrics_slot(slot, slots): processes the tenants
--    whose position (ordered by id) mod `slots` = `slot`. Each tenant runs in
--    its own BEGIN … EXCEPTION block: an error rolls back only that tenant
--    and the loop goes on. A transaction-level advisory lock prevents two
--    runs (cron + manual, or a slow cron run + the next one) from overlapping;
--    a run that cannot get the lock does nothing.
--  * Per-tenant statement timeout: the cron command issues one top-level
--    SELECT per slot after `SET statement_timeout = '60s'`. Since PG 13 the
--    timeout is applied to each statement of a multi-statement simple query
--    separately, so each slot gets its own 60 s budget. While the number of
--    tenants is <= 8 (6 today) every slot holds at most one tenant, i.e. the
--    timeout is per tenant; above that it is per group of ceil(n/8) tenants.
--    A timeout (SQLSTATE 57014) is caught inside the tenant block: that tenant
--    is rolled back, the slot stops (the timer is one-shot) and the next slot
--    starts with a fresh 60 s timer. Completed tenants are kept.
--  * refresh_recent_dashboard_metrics() keeps its signature and outputs for
--    manual calls: it takes the same lock and processes all tenants with the
--    same per-tenant exception handling (bounded only by the caller's
--    statement_timeout, as before).
--  * One dispatcher_runs row per slot that had work (job =
--    'dashboard_metrics_refresh') so observability_job_health() shows
--    liveness and failures (stop_reason done | error | timeout). Error text is
--    SQLSTATE + message only (no row data).
--
-- Side note: a manual pg_cancel_backend() on the cron backend is also seen as
-- 57014 and only stops the current slot; use pg_terminate_backend() to stop
-- the whole run.

create or replace function public.refresh_recent_dashboard_metrics_tenant(_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_day date;
begin
  -- Eventos podem chegar com atraso; atualizamos hoje e ontem fora da
  -- requisição do usuário. Dias mais antigos já permanecem materializados.
  for v_day in select generate_series(v_today - 1, v_today, interval '1 day')::date loop
    perform public.refresh_tenant_daily_metric_day(_tenant, v_day);
  end loop;
end;
$$;

revoke all on function public.refresh_recent_dashboard_metrics_tenant(uuid) from public, anon, authenticated;
grant execute on function public.refresh_recent_dashboard_metrics_tenant(uuid) to service_role;

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

-- Same signature and outputs as before; now isolated per tenant and guarded
-- by the same advisory lock. The useless function-level statement_timeout is
-- dropped (it never bounded the calling statement).
create or replace function public.refresh_recent_dashboard_metrics()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_recent_dashboard_metrics_slot(0, 1);
end;
$$;

alter function public.refresh_recent_dashboard_metrics() reset statement_timeout;

revoke all on function public.refresh_recent_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.refresh_recent_dashboard_metrics() to service_role;

-- Cron: one top-level statement per slot so each gets its own
-- statement_timeout. pg_cron runs the command as a single simple query
-- (implicit transaction): all slots commit together at the end; a caught
-- timeout does not abort the transaction. pg_cron does not start a job again
-- while the previous run of the same job is still running.
do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-refresh-dashboard-metrics'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-refresh-dashboard-metrics',
  '*/5 * * * *',
  $job$SET statement_timeout = '60s'; SET lock_timeout = '5s';
SELECT public.refresh_recent_dashboard_metrics_slot(0, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(1, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(2, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(3, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(4, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(5, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(6, 8);
SELECT public.refresh_recent_dashboard_metrics_slot(7, 8);$job$
);
