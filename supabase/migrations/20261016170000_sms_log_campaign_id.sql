-- Campaign id on SMS logs (Central de Resultados F1 pending item).
--
-- Campaign SMS only carried the campaign *name* in trigger_name
-- ("campanha:<name>:<route>"), so results were resolved by name (18 campaigns,
-- 17 distinct names). Every send path goes through sms_send_logs, so the id is
-- resolved once, at insert, by a trigger: the most recent non-cancelled
-- campaign of the tenant with that name created before the send. Existing logs
-- are backfilled with the same rule, and crm_results_daily prefers the id.

alter table public.sms_send_logs add column if not exists campaign_id uuid;

create or replace function public.resolve_sms_log_campaign_id(_tenant uuid, _trigger text, _at timestamptz)
returns uuid
language sql
stable
set search_path = public
as $$
  select c.id
  from public.sms_campaigns c
  where _trigger like 'campanha:%'
    and c.tenant_id = _tenant
    and c.name = regexp_replace(_trigger, '^campanha:(.*):[^:]*$', '\1')
    and c.created_at <= coalesce(_at, now())
  order by (c.status = 'cancelada'), c.created_at desc
  limit 1;
$$;

create or replace function public.set_sms_log_campaign_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.campaign_id is null and new.trigger_name like 'campanha:%' then
    new.campaign_id := public.resolve_sms_log_campaign_id(
      new.tenant_id, new.trigger_name, coalesce(new.created_at, now()));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sms_log_campaign_id on public.sms_send_logs;
create trigger trg_sms_log_campaign_id
before insert on public.sms_send_logs
for each row execute function public.set_sms_log_campaign_id();

-- Backfill (~50k campaign logs): one indexed lookup per row in the small sms_campaigns table.
with resolved as (
  select s.id, public.resolve_sms_log_campaign_id(s.tenant_id, s.trigger_name, s.created_at) campaign_id
  from public.sms_send_logs s
  where s.trigger_name like 'campanha:%' and s.campaign_id is null
)
update public.sms_send_logs s
set campaign_id = r.campaign_id
from resolved r
where s.id = r.id and r.campaign_id is not null;

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
    select src.source_type,
           case when s.campaign_id is not null
                then coalesce((select c.name from public.sms_campaigns c where c.id = s.campaign_id), src.source_key)
                else src.source_key end source_key,
           coalesce(s.campaign_id, src.source_id) source_id,
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
    select e.player_id, e.valor, ls.trigger_name, ls.idempotency_key, ls.sent_at, ls.campaign_id
    from eligible e
    cross join lateral (
      select s.trigger_name, s.idempotency_key, s.created_at sent_at, s.campaign_id
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
    select src.source_type,
           case when c.campaign_id is not null
                then coalesce((select sc.name from public.sms_campaigns sc where sc.id = c.campaign_id), src.source_key)
                else src.source_key end source_key,
           max(coalesce(c.campaign_id, src.source_id)::text)::uuid source_id,
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
revoke all on function public.resolve_sms_log_campaign_id(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.resolve_sms_log_campaign_id(uuid, text, timestamptz) to service_role;
