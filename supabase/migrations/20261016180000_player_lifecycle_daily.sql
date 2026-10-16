-- Central de Resultados F4: how the base moves between states over time
-- (docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md 7.5, "fluxo entre estados").
--
-- player_lifecycle_daily: players per state at the END of each day (BRT), from
-- the deposit history, so past days can be rebuilt. States match
-- crm_player_state: sem_ftd | ativo < 48 h | esfriando < 7 d | dormindo < 30 d |
-- perdido >= 30 d | sem_historico (deposits before our history). Refreshed with
-- crm_results_daily (today + yesterday every 10 minutes, last 8 days daily).

create table if not exists public.player_lifecycle_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  state text not null,
  players integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric_date, state)
);

alter table public.player_lifecycle_daily enable row level security;

drop policy if exists "player lifecycle read" on public.player_lifecycle_daily;
create policy "player lifecycle read"
on public.player_lifecycle_daily for select to authenticated
using (public.has_tenant_access(tenant_id));

create or replace function public.refresh_player_lifecycle_day(_tenant uuid, _day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end timestamptz := ((_day + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_rows integer;
begin
  delete from public.player_lifecycle_daily where tenant_id = _tenant and metric_date = _day;
  insert into public.player_lifecycle_daily (tenant_id, metric_date, state, players, updated_at)
  select _tenant, _day, state, count(*), now()
  from (
    select case
             when x.last_at is null and (p.ftd_em is null or p.ftd_em >= v_end) then 'sem_ftd'
             when x.last_at is null then 'sem_historico'
             when v_end - x.last_at < interval '48 hours' then 'ativo'
             when v_end - x.last_at < interval '7 days' then 'esfriando'
             when v_end - x.last_at < interval '30 days' then 'dormindo'
             else 'perdido'
           end state
    from public.players p
    cross join lateral (
      select max(d.created_at) last_at
      from public.deposits d
      where d.tenant_id = _tenant and d.player_id = p.id
        and d.status = 'aprovado' and d.created_at < v_end
    ) x
    where p.tenant_id = _tenant and p.created_at < v_end
  ) states
  group by state;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_player_lifecycle_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_player_lifecycle_day(uuid, date) to service_role;

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
  for v_tenant in select id from public.tenants order by id loop
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
