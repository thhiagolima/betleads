-- CRM results: rebuild past days that received late data.
--
-- Since 20261129100000 the 15-minute run rebuilds only today; yesterday runs
-- at 00:10 BRT and the last 8 days at 03:20 BRT. On 04-05/11 a house platform
-- delivered webhooks up to ~15 h late (queue drained at ~07:00 BRT), after
-- both runs: 04/11 missed ~2,000 approved deposits of three houses until a
-- manual rebuild. Now every run also rebuilds any of the last 8 days whose
-- approved deposits changed after that day's last rebuild, so a late
-- delivery is reflected within 15 minutes without rebuilding yesterday all
-- the time.
--
-- crm_results_refresh_log records when each house/day was last rebuilt (or
-- checked and skipped). crm_results_daily.updated_at cannot do this: a day
-- whose rebuild writes no rows would look stale forever.

create table if not exists public.crm_results_refresh_log (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  refreshed_at timestamptz not null,
  primary key (tenant_id, metric_date)
);
alter table public.crm_results_refresh_log enable row level security;
revoke all on table public.crm_results_refresh_log from public, anon, authenticated;

-- base: 20261129100000_supabase_consumo_p0.sql
create or replace function public.refresh_crm_results_recent(_days integer default 2)
returns integer -- tenants that failed (-1 = skipped, another run holds the lock)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_window_from date := v_today - greatest(1, _days) + 1;
  -- Late data is looked for in the 8 days the daily 03:20 run also covers.
  v_late_from date := v_today - 7;
  v_tenant uuid;
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v_started timestamptz;
  v_failed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('betleads.refresh_crm_results')::bigint) then
    return -1;
  end if;
  for v_tenant in select id from public.tenants where not is_demo order by id loop
    begin
      for v_day in
        -- The requested window, as before.
        select generate_series(v_window_from, v_today, interval '1 day')::date
        union
        -- Older days whose approved deposits changed after their last rebuild
        -- (late webhook, late approval). (tenant_id, status, created_at) index.
        select changed.day
        from (
          select (d.created_at at time zone 'America/Sao_Paulo')::date as day,
                 max(d.updated_at) as last_change
          from public.deposits d
          where d.tenant_id = v_tenant
            and d.status = 'aprovado'
            and d.created_at >= (v_late_from::timestamp at time zone 'America/Sao_Paulo')
            and d.created_at < (v_window_from::timestamp at time zone 'America/Sao_Paulo')
          group by 1
        ) changed
        left join public.crm_results_refresh_log l
          on l.tenant_id = v_tenant and l.metric_date = changed.day
        where l.refreshed_at is null or changed.last_change > l.refreshed_at
        order by 1
      loop
        -- Taken before the rebuild: a change during it triggers another one.
        v_started := clock_timestamp();
        v_from := (v_day::timestamp at time zone 'America/Sao_Paulo');
        v_to := ((v_day + 1)::timestamp at time zone 'America/Sao_Paulo');
        -- Every part of the day rebuild starts from one of these four; with
        -- none of them and nothing stored, the rebuild would write nothing.
        if exists (select 1 from public.sms_send_logs s
                   where s.tenant_id = v_tenant and s.created_at >= v_from and s.created_at < v_to)
           or exists (select 1 from public.click_events ce
                      where ce.tenant_id = v_tenant and ce.is_human
                        and ce.occurred_at >= v_from and ce.occurred_at < v_to)
           or exists (select 1 from public.conversion_attributions a
                      where a.tenant_id = v_tenant
                        and a.occurred_at >= v_from and a.occurred_at < v_to)
           or exists (select 1 from public.deposits d
                      where d.tenant_id = v_tenant and d.status = 'aprovado'
                        and d.created_at >= v_from and d.created_at < v_to)
           or exists (select 1 from public.crm_results_daily r
                      where r.tenant_id = v_tenant and r.metric_date = v_day)
        then
          perform public.refresh_crm_results_day(v_tenant, v_day);
        end if;
        perform public.refresh_player_lifecycle_day(v_tenant, v_day);
        insert into public.crm_results_refresh_log (tenant_id, metric_date, refreshed_at)
        values (v_tenant, v_day, v_started)
        on conflict (tenant_id, metric_date) do update set refreshed_at = excluded.refreshed_at;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'refresh_crm_results: tenant % failed: % %', v_tenant, sqlstate, left(sqlerrm, 200);
    end;
  end loop;
  -- Older entries are never read again (the late check looks 8 days back).
  delete from public.crm_results_refresh_log where metric_date < v_today - 30;
  return v_failed;
end;
$$;

revoke all on function public.refresh_crm_results_recent(integer) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_recent(integer) to service_role;
