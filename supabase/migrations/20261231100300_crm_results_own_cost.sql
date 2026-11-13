-- Conta própria de provedor por casa — Tarefa 4: custo informado na Central.
--
-- O QUE FAZ
--   refresh_crm_results_day (corpo copiado de
--   20261220100000_crm_influenced_superset.sql, rule_version 5; única
--   mudança no cálculo do custo do SMS): o CTE `sends` agora faz left join com provider_accounts
--   pelo provider_account_id do log e calcula, por linha, `unit_cost` — se a
--   conta pertence à própria casa (owner_tenant_id = _tenant), usa
--   own_unit_cost (null = 0); senão (conta da plataforma ou conta
--   inexistente/apagada), usa o preço de venda da casa (v_price), igual ao
--   comportamento de hoje. `sends_agg.cost` soma billed_units * unit_cost por
--   linha em vez de billed_units * v_price. Um log com provider_account_id
--   apontando para uma conta que não existe mais (casa com conta própria
--   excluída) não quebra a Central: o left join não acha linha e o envio
--   custa pelo preço de venda (Review Focus 4).
--
-- COMPATIBILIDADE
--   Aditiva: provider_account_id e provider_accounts já existem (Tarefa 1);
--   nenhuma coluna ou tabela nova. Logs sem provider_account_id (app antigo,
--   ou canal sem conta própria) continuam custando pelo preço de venda,
--   igual a antes. Aplicar antes do app que grava provider_account_id nos
--   envios por conta própria (Tarefa 6).
--
-- ROLLBACK
--   Reaplicar a função de 20261220100000_crm_influenced_superset.sql (CREATE
--   OR REPLACE devolve o corpo anterior, sem o custo por conta própria).

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
  v_price := public.crm_sms_report_price(_tenant, v_from);

  delete from public.crm_results_daily where tenant_id = _tenant and metric_date = _day;
  delete from public.crm_influenced_players_daily where tenant_id = _tenant and metric_date = _day;

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
           s.billed_units,
           case when pa.owner_tenant_id = _tenant then coalesce(pa.own_unit_cost, 0) else v_price end unit_cost,
           s.status in ('sent', 'delivered', 'enviado', 'entregue') is_sent,
           s.status in ('error', 'erro', 'failed') is_failed
    from public.sms_send_logs s
    cross join lateral public.crm_source_of_trigger(_tenant, s.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key = public.crm_try_uuid(s.idempotency_key)
    left join public.provider_accounts pa on pa.id = s.provider_account_id
    where s.tenant_id = _tenant and s.created_at >= v_from and s.created_at < v_to
  ),
  sends_agg as (
    select s.source_type, s.source_key, max(s.source_id::text)::uuid source_id, s.step_position, s.player_state,
           count(*) filter (where s.is_sent) sent,
           count(*) filter (where s.is_failed) failed,
           coalesce(sum(coalesce(s.billed_units, 1) * s.unit_cost) filter (where s.is_sent), 0) cost,
           count(distinct s.player_id) filter (where s.is_sent) recipients,
           0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from sends s group by 1, 2, 4, 5
  ),
  -- Direct deposits of the dispatches that matter for the day (clicked on the
  -- day, or with a deposit on the day), flagged per dispatch.
  direct_deps as (
    select * from public.crm_direct_deposits(_tenant, v_from - interval '8 days')
  ),
  dispatch_origin as (
    select ld.id,
           ld.source_type,
           case when ld.source_type = 'campaign'
                then coalesce((select c.name from public.sms_campaigns c
                               where c.id::text = ld.source_id), ld.source_id)
                else lower(ld.source_id) end source_key,
           case when ld.source_id ~* '^[0-9a-f-]{36}$' then ld.source_id::uuid end source_id,
           coalesce(ld.journey_step_position, -1) step_position,
           ld.recipient_player_id player_id,
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
  -- Dispatches that brought a deposit of a player who was not active.
  converted_dispatches as (
    select distinct d.link_dispatch_id id from direct_deps d where not d.was_active
  ),
  clicks_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients,
           count(distinct ce.link_dispatch_id) human_clicks,
           count(distinct ce.link_dispatch_id) filter (where cd.id is not null) converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from public.click_events ce
    join dispatch_origin o on o.id = ce.link_dispatch_id
    left join converted_dispatches cd on cd.id = ce.link_dispatch_id
    where ce.tenant_id = _tenant and ce.is_human
      and ce.occurred_at >= v_from and ce.occurred_at < v_to
    group by 1, 2, 4, 5
  ),
  -- Direct deposits of the day with their dispatch origin (direct and part 1).
  day_direct as (
    select o.source_type, o.source_key, o.source_id, o.step_position, o.player_state,
           d.player_id, d.was_active, d.is_first, d.monetary_value
    from direct_deps d
    join dispatch_origin o on o.id = d.link_dispatch_id
    where d.occurred_at >= v_from and d.occurred_at < v_to
  ),
  direct_agg as (
    select d.source_type, d.source_key, max(d.source_id::text)::uuid source_id, d.step_position, d.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           count(*) filter (where not d.was_active) direct_conversions,
           -- A player converted by one SMS counts once, on the day of the first deposit.
           count(distinct d.player_id) filter (where not d.was_active and d.is_first) direct_players,
           coalesce(sum(d.monetary_value) filter (where not d.was_active), 0) direct_revenue,
           count(*) filter (where d.was_active) direct_active_conversions,
           count(distinct d.player_id) filter (where d.was_active) direct_active_players,
           coalesce(sum(d.monetary_value) filter (where d.was_active), 0) direct_active_revenue,
           -- Part 1 of the influenced view: the Recuperado pelo CRM itself.
           count(distinct d.player_id) filter (where not d.was_active and d.is_first) influenced_players,
           count(*) filter (where not d.was_active) influenced_deposits,
           coalesce(sum(d.monetary_value) filter (where not d.was_active), 0) influenced_revenue
    from day_direct d
    group by 1, 2, 4, 5
  ),
  -- Players whose deposits of the day are already in part 1.
  clicked_today as (
    select distinct d.player_id from day_direct d where not d.was_active
  ),
  deps as (
    select d.id, d.player_id, d.valor, d.created_at
    from public.deposits d
    where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
      and d.created_at >= v_from and d.created_at < v_to
  ),
  -- Part 2 candidates: depositors of the day not in part 1 who received an
  -- accepted SMS in the 6 days before (a return of the last 3 days needs an
  -- SMS in the 3 days before it).
  exposed_players as (
    select p.player_id
    from (select distinct d.player_id from deps d) p
    where not exists (select 1 from clicked_today c where c.player_id = p.player_id)
      and exists (
        select 1 from public.sms_send_logs s
        where s.tenant_id = _tenant and s.player_id = p.player_id
          and s.status in ('sent', 'delivered', 'enviado', 'entregue')
          and s.created_at >= v_from - interval '6 days' and s.created_at < v_to
      )
  ),
  -- Their approved deposits from 5 days before the day: a return of the last
  -- 3 days needs 48 h without deposits before it, and those 2 extra days show
  -- the deposit right before it.
  recent_deps as (
    select r.id, r.player_id, r.created_at,
           lag(r.created_at) over (partition by r.player_id order by r.created_at, r.id) prev_in_window
    from exposed_players p
    join public.deposits r
      on r.tenant_id = _tenant and r.player_id = p.player_id and r.status = 'aprovado'
     and r.created_at >= v_from - interval '5 days' and r.created_at < v_to
  ),
  -- Deposits with 48 h of silence before them: the only ones that can be a
  -- return (stopped at an SMS sent before them).
  returns as (
    select r.id, r.player_id, r.created_at, pv.prev_at,
           pl.ftd_em, pl.created_at registered_at
    from recent_deps r
    join public.players pl on pl.id = r.player_id
    cross join lateral (
      select max(p.created_at) prev_at from public.deposits p
      where p.tenant_id = _tenant and p.player_id = r.player_id
        and p.status = 'aprovado' and p.created_at < r.created_at
    ) pv
    where r.created_at > v_from - interval '3 days'
      and (r.prev_in_window is null or r.prev_in_window < r.created_at - interval '48 hours')
      -- A first deposit in our history of an older depositor is not a return.
      and (pv.prev_at is not null or pl.ftd_em is null or pl.ftd_em >= r.created_at - interval '10 minutes')
  ),
  -- Last accepted SMS in the 3 days before the return, sent while the player
  -- was stopped: no deposit in the 48 h before it (nor after it, as the
  -- return is the next deposit). A first deposit needs the SMS 48 h+ after
  -- sign-up. The origin and state belong to that SMS.
  credited as (
    select r.id return_id, r.player_id, r.created_at returned_at,
           ls.trigger_name, ls.idempotency_key, ls.campaign_id,
           public.crm_player_state(_tenant, r.player_id, ls.sent_at) player_state
    from returns r
    cross join lateral (
      select s.trigger_name, s.idempotency_key, s.created_at sent_at, s.campaign_id
      from public.sms_send_logs s
      where s.tenant_id = _tenant and s.player_id = r.player_id
        and s.status in ('sent', 'delivered', 'enviado', 'entregue')
        and s.created_at < r.created_at
        and s.created_at >= r.created_at - interval '3 days'
        and (case when r.prev_at is null then s.created_at >= r.registered_at + interval '48 hours'
                  else s.created_at > r.prev_at + interval '48 hours' end)
      order by s.created_at desc
      limit 1
    ) ls
  ),
  -- Deposits of the day within 3 days of a credited return (the latest one).
  exposed_deps as (
    select distinct on (d.id) d.id, d.player_id, d.valor, d.id = c.return_id is_return,
           c.trigger_name, c.idempotency_key, c.campaign_id, c.player_state
    from deps d
    join credited c
      on c.player_id = d.player_id
     and d.created_at >= c.returned_at and d.created_at < c.returned_at + interval '3 days'
    order by d.id, c.returned_at desc
  ),
  exposure_agg as (
    select src.source_type,
           case when e.campaign_id is not null
                then coalesce((select sc.name from public.sms_campaigns sc where sc.id = e.campaign_id), src.source_key)
                else src.source_key end source_key,
           max(coalesce(e.campaign_id, src.source_id)::text)::uuid source_id,
           coalesce(x.step_position, -1) step_position,
           e.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           count(distinct e.player_id) filter (where e.is_return) influenced_players,
           count(*) influenced_deposits,
           coalesce(sum(e.valor), 0) influenced_revenue
    from exposed_deps e
    cross join lateral public.crm_source_of_trigger(_tenant, e.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key = public.crm_try_uuid(e.idempotency_key)
    group by 1, 2, 4, 5
  ),
  -- People of the day for the period's distinct count.
  saved_players as (
    insert into public.crm_influenced_players_daily (tenant_id, metric_date, player_id)
    select _tenant, _day, people.player_id
    from (
      select d.player_id from day_direct d where not d.was_active and d.is_first
      union
      select e.player_id from exposed_deps e where e.is_return
    ) people
    on conflict do nothing
    returning 1
  ),
  all_parts as (
    select * from sends_agg
    union all select * from clicks_agg
    union all select * from direct_agg
    union all select * from exposure_agg
  )
  insert into public.crm_results_daily (
    tenant_id, metric_date, source_type, source_key, source_id, step_position, player_state,
    sent, failed, cost, recipients, human_clicks, converted_clicks,
    direct_conversions, direct_players, direct_revenue,
    direct_active_conversions, direct_active_players, direct_active_revenue,
    influenced_players, influenced_deposits, influenced_revenue, rule_version, updated_at
  )
  select _tenant, _day, source_type, source_key, max(source_id::text)::uuid, step_position, player_state,
         sum(sent), sum(failed), sum(cost), sum(recipients), sum(human_clicks), sum(converted_clicks),
         sum(direct_conversions), sum(direct_players), sum(direct_revenue),
         sum(direct_active_conversions), sum(direct_active_players), sum(direct_active_revenue),
         sum(influenced_players), sum(influenced_deposits), sum(influenced_revenue),
         5, now()
  from all_parts
  group by source_type, source_key, step_position, player_state;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_day(uuid, date) to service_role;
