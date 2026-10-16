-- Central de Resultados F1: daily CRM results per origin, step and player state
-- (docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md, section 6.2).
--
-- One row per tenant x day (America/Sao_Paulo) x origin x journey step x
-- player state at send. Everything is derived from data that already exists,
-- so history can be rebuilt and the send path does not change:
--   * sends / failures / cost   sms_send_logs (cost = accepted SMS x tenant price)
--   * origin                    trigger_name: "journey:<id>" or "campanha:<name>:<route>"
--   * journey step              journey_step_executions.idempotency_key = log key
--   * human clicks              click_events (is_human) -> link_dispatches
--   * direct recovery           conversion_attributions (click -> deposit, 7 days)
--   * influenced recovery       approved deposit of a player inactive >= 48 h (or a
--                               true first deposit) within 72 h after an accepted
--                               SMS; credited ONCE, to the last SMS before it
--   * player state at send      last approved deposit before the send:
--                               sem_ftd | ativo < 48 h | esfriando < 7 d |
--                               dormindo < 30 d | perdido >= 30 d |
--                               sem_historico (depositor whose deposits predate
--                               our history, which starts on 2026-09-02)
-- Direct and influenced are separate levels and must never be summed.
-- rule_version marks the definitions above; a change of rule bumps it.

create table if not exists public.crm_results_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  source_type text not null check (source_type in ('journey', 'campaign', 'other')),
  source_key text not null,
  source_id uuid,
  step_position integer not null default -1,
  player_state text not null,
  sent integer not null default 0,
  failed integer not null default 0,
  cost numeric not null default 0,
  recipients integer not null default 0,
  human_clicks integer not null default 0,
  direct_conversions integer not null default 0,
  direct_revenue numeric not null default 0,
  influenced_players integer not null default 0,
  influenced_deposits integer not null default 0,
  influenced_revenue numeric not null default 0,
  rule_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric_date, source_type, source_key, step_position, player_state)
);

alter table public.crm_results_daily enable row level security;

drop policy if exists "crm results read" on public.crm_results_daily;
create policy "crm results read"
on public.crm_results_daily for select to authenticated
using (public.has_tenant_access(tenant_id));

create index if not exists crm_results_daily_tenant_date_idx
  on public.crm_results_daily (tenant_id, metric_date desc);

-- Last accepted SMS of a player before a deposit (influenced recovery).
create index if not exists sms_send_logs_tenant_player_created_idx
  on public.sms_send_logs (tenant_id, player_id, created_at desc)
  where player_id is not null;

-- ---------------------------------------------------------------------------
-- Player state at a moment, from approved deposits.
-- ---------------------------------------------------------------------------
create or replace function public.crm_player_state(_tenant uuid, _player uuid, _at timestamptz)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when _player is null then 'desconhecido'
    when x.last_at is null then
      case when x.ftd_em is not null and x.ftd_em < _at then 'sem_historico' else 'sem_ftd' end
    when _at - x.last_at < interval '48 hours' then 'ativo'
    when _at - x.last_at < interval '7 days' then 'esfriando'
    when _at - x.last_at < interval '30 days' then 'dormindo'
    else 'perdido'
  end
  from (
    select max(d.created_at) last_at,
           (select p.ftd_em from public.players p where p.id = _player) ftd_em
    from public.deposits d
    where d.tenant_id = _tenant and d.player_id = _player
      and d.status = 'aprovado' and d.created_at < _at
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- Origin of an SMS log (journey id, campaign name or trigger prefix).
-- ---------------------------------------------------------------------------
create or replace function public.crm_source_of_trigger(_tenant uuid, _trigger text)
returns table (source_type text, source_key text, source_id uuid)
language sql
stable
set search_path = public
as $$
  select
    case
      when _trigger ~* '^journey:[0-9a-f-]{36}$' then 'journey'
      when _trigger like 'campanha:%' then 'campaign'
      else 'other'
    end,
    case
      when _trigger ~* '^journey:[0-9a-f-]{36}$' then lower(substring(_trigger from 9))
      when _trigger like 'campanha:%' then regexp_replace(_trigger, '^campanha:(.*):[^:]*$', '\1')
      else coalesce(nullif(split_part(coalesce(_trigger, ''), ':', 1), ''), '(sem origem)')
    end,
    case
      when _trigger ~* '^journey:[0-9a-f-]{36}$' then substring(_trigger from 9)::uuid
      when _trigger like 'campanha:%' then (
        select c.id from public.sms_campaigns c
        where c.tenant_id = _tenant
          and c.name = regexp_replace(_trigger, '^campanha:(.*):[^:]*$', '\1')
        order by c.created_at desc
        limit 1
      )
    end;
$$;

-- ---------------------------------------------------------------------------
-- Rebuild one tenant-day.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_crm_results_day(_tenant uuid, _day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := (_day::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((_day + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_price numeric;
  v_rows integer;
begin
  select coalesce(
    (select sale_price_per_sms from public.tenant_sms_pricing where tenant_id = _tenant),
    (select default_sale_price_per_sms from public.sms_credit_settings limit 1),
    0.12
  ) into v_price;

  delete from public.crm_results_daily where tenant_id = _tenant and metric_date = _day;

  insert into public.crm_results_daily (
    tenant_id, metric_date, source_type, source_key, source_id, step_position, player_state,
    sent, failed, cost, recipients, human_clicks, direct_conversions, direct_revenue,
    influenced_players, influenced_deposits, influenced_revenue, rule_version, updated_at
  )
  with
  sends as (
    select src.source_type, src.source_key, src.source_id,
           coalesce(x.step_position, -1) step_position,
           public.crm_player_state(_tenant, s.player_id, s.created_at) player_state,
           s.player_id,
           s.status in ('sent', 'delivered', 'enviado', 'entregue') is_sent,
           s.status in ('error', 'erro', 'failed') is_failed
    from public.sms_send_logs s
    cross join lateral public.crm_source_of_trigger(_tenant, s.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key::text = s.idempotency_key
    where s.tenant_id = _tenant and s.created_at >= v_from and s.created_at < v_to
  ),
  sends_agg as (
    select source_type, source_key, max(source_id::text)::uuid source_id, step_position, player_state,
           count(*) filter (where is_sent) sent,
           count(*) filter (where is_failed) failed,
           count(*) filter (where is_sent) * v_price cost,
           count(distinct player_id) filter (where is_sent) recipients,
           0 human_clicks, 0 direct_conversions, 0::numeric direct_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from sends group by 1, 2, 4, 5
  ),
  -- Dispatch (tracked link) -> origin, step and player state at send.
  dispatch_origin as (
    select ld.id,
           ld.source_type,
           case when ld.source_type = 'campaign'
                then coalesce((select c.name from public.sms_campaigns c
                               where c.id::text = ld.source_id), ld.source_id)
                else lower(ld.source_id) end source_key,
           case when ld.source_id ~* '^[0-9a-f-]{36}$' then ld.source_id::uuid end source_id,
           coalesce(ld.journey_step_position, -1) step_position,
           public.crm_player_state(_tenant, ld.recipient_player_id, coalesce(ld.sent_at, ld.created_at)) player_state
    from public.link_dispatches ld
    where ld.tenant_id = _tenant
      and ld.source_type in ('campaign', 'journey')
      and ld.id in (
        select ce.link_dispatch_id from public.click_events ce
        where ce.tenant_id = _tenant and ce.is_human
          and ce.occurred_at >= v_from and ce.occurred_at < v_to
        union
        select a.link_dispatch_id from public.conversion_attributions a
        where a.tenant_id = _tenant and a.occurred_at >= v_from and a.occurred_at < v_to
      )
  ),
  clicks_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients,
           count(distinct ce.link_dispatch_id) human_clicks,
           0 direct_conversions, 0::numeric direct_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from public.click_events ce
    join dispatch_origin o on o.id = ce.link_dispatch_id
    where ce.tenant_id = _tenant and ce.is_human
      and ce.occurred_at >= v_from and ce.occurred_at < v_to
    group by 1, 2, 4, 5
  ),
  direct_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks,
           count(*) direct_conversions,
           coalesce(sum(a.monetary_value), 0) direct_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from public.conversion_attributions a
    join dispatch_origin o on o.id = a.link_dispatch_id
    where a.tenant_id = _tenant and a.classification = 'direct'
      and a.event_type = 'deposit_approved'
      and a.occurred_at >= v_from and a.occurred_at < v_to
    group by 1, 2, 4, 5
  ),
  deps as (
    select d.id, d.player_id, d.valor, d.created_at,
           (select max(p.created_at) from public.deposits p
            where p.tenant_id = _tenant and p.player_id = d.player_id
              and p.status = 'aprovado' and p.created_at < d.created_at) prev_at,
           (select pl.ftd_em from public.players pl where pl.id = d.player_id) ftd_em
    from public.deposits d
    where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
      and d.created_at >= v_from and d.created_at < v_to
  ),
  -- Returning (>= 48 h without depositing) or a true first deposit; a first
  -- deposit in our history of an older depositor is not a recovery.
  eligible as (
    select * from deps
    where (prev_at is not null and created_at - prev_at >= interval '48 hours')
       or (prev_at is null and (ftd_em is null or ftd_em >= created_at - interval '10 minutes'))
  ),
  credited as (
    select e.player_id, e.valor, ls.trigger_name, ls.idempotency_key, ls.sent_at
    from eligible e
    cross join lateral (
      select s.trigger_name, s.idempotency_key, s.created_at sent_at
      from public.sms_send_logs s
      where s.tenant_id = _tenant and s.player_id = e.player_id
        and s.status in ('sent', 'delivered', 'enviado', 'entregue')
        and s.created_at < e.created_at
        and s.created_at >= e.created_at - interval '72 hours'
      order by s.created_at desc
      limit 1
    ) ls
  ),
  influenced_agg as (
    select src.source_type, src.source_key, max(src.source_id::text)::uuid source_id,
           coalesce(x.step_position, -1) step_position,
           public.crm_player_state(_tenant, c.player_id, c.sent_at) player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks,
           0 direct_conversions, 0::numeric direct_revenue,
           count(distinct c.player_id) influenced_players,
           count(*) influenced_deposits,
           coalesce(sum(c.valor), 0) influenced_revenue
    from credited c
    cross join lateral public.crm_source_of_trigger(_tenant, c.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key::text = c.idempotency_key
    group by 1, 2, 4, 5
  ),
  all_parts as (
    select * from sends_agg
    union all select * from clicks_agg
    union all select * from direct_agg
    union all select * from influenced_agg
  )
  select _tenant, _day, source_type, source_key, max(source_id::text)::uuid, step_position, player_state,
         sum(sent), sum(failed), sum(cost), sum(recipients), sum(human_clicks),
         sum(direct_conversions), sum(direct_revenue),
         sum(influenced_players), sum(influenced_deposits), sum(influenced_revenue),
         1, now()
  from all_parts
  group by source_type, source_key, step_position, player_state;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_day(uuid, date) to service_role;
revoke all on function public.crm_player_state(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.crm_player_state(uuid, uuid, timestamptz) to service_role;
revoke all on function public.crm_source_of_trigger(uuid, text) from public, anon, authenticated;
grant execute on function public.crm_source_of_trigger(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled refresh: today + yesterday for every tenant, one tenant failing
-- never stops the others, and runs never overlap.
-- ---------------------------------------------------------------------------
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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job
      where jobname in ('betleads-crm-results-recent', 'betleads-crm-results-week');
    -- Today and yesterday, every 10 minutes.
    perform cron.schedule(
      'betleads-crm-results-recent',
      '*/10 * * * *',
      $cron$set statement_timeout = '300s'; select public.refresh_crm_results_recent(2);$cron$
    );
    -- Late events (webhooks, refunds): the last 8 days once a day, 03:20 BRT.
    perform cron.schedule(
      'betleads-crm-results-week',
      '20 6 * * *',
      $cron$set statement_timeout = '900s'; select public.refresh_crm_results_recent(8);$cron$
    );
  end if;
end $$;
