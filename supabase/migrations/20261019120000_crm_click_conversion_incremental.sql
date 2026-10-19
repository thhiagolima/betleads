-- Central de Resultados: click conversion counts only players who were not
-- already active (docs/AUDITORIA_NUMEROS_RESULTADOS_CRM_2026-10-19.md).
--
-- Until rule_version 2 every deposit up to 7 days after a click was a click
-- conversion. On 18/10 at Sorte Alta 69% of that revenue came from players who
-- had deposited in the 48 h before the click (18.9 deposits a week on average):
-- they would have deposited anyway. rule_version 3:
--   * F1  a click converts only a player with no approved deposit in the 48 h
--         before the first click on that SMS (same cut as "ativo" and the
--         influenced view). Deposits of players already active go to
--         direct_active_* and never into the click revenue or return.
--   * F3  a converted player counts on the day of the first deposit coming
--         from that SMS, not again on every later day; period totals use
--         crm_click_players_period (distinct players).
--   * F2  converted_clicks: SMS clicked on the day that brought a deposit of a
--         non-active player (cohort of the click). Rate = converted_clicks /
--         human_clicks; it grows for 7 days after the click.
--   * F5  list_journey_metrics "recovered" uses the same rule.
-- Rebuild the history after applying (refresh_crm_results_day for each day).

alter table public.crm_results_daily
  add column if not exists direct_active_conversions integer not null default 0,
  add column if not exists direct_active_players integer not null default 0,
  add column if not exists direct_active_revenue numeric not null default 0,
  add column if not exists converted_clicks integer not null default 0;

-- Player already active at the click: an approved deposit in the 48 h before
-- it (crm_player_state = 'ativo').
create or replace function public.crm_click_was_active(_tenant uuid, _player uuid, _click_at timestamptz)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.deposits d
    where d.tenant_id = _tenant and d.player_id = _player and d.status = 'aprovado'
      and d.created_at < _click_at and d.created_at >= _click_at - interval '48 hours'
  );
$$;

-- Direct deposit attributions of a tenant with the rule_version 3 flags. The
-- flags belong to the SMS (link dispatch): activity is checked at its first
-- attributed click, so a player reactivated by a click keeps counting for the
-- whole 7-day window. Every attribution of a dispatch falls within 7 days of
-- its click, so _since = start of the period - 8 days yields complete dispatches.
create or replace function public.crm_direct_deposits(_tenant uuid, _since timestamptz default '-infinity')
returns table (
  attribution_id uuid,
  link_dispatch_id uuid,
  source_type text,
  source_id uuid,
  player_id uuid,
  occurred_at timestamptz,
  monetary_value numeric,
  was_active boolean,
  is_first boolean
)
language sql
stable
set search_path = public
as $$
  select x.id, x.link_dispatch_id, x.source_type, x.source_id, x.player_id, x.occurred_at,
         coalesce(x.monetary_value, 0),
         public.crm_click_was_active(_tenant, x.player_id, x.first_click_at),
         x.position = 1
  from (
    select a.*,
           min(coalesce(a.window_started_at, a.occurred_at)) over w first_click_at,
           row_number() over (w order by a.occurred_at, a.id) position
    from public.conversion_attributions a
    where a.tenant_id = _tenant and a.classification = 'direct'
      and a.event_type = 'deposit_approved' and a.occurred_at >= _since
    window w as (partition by a.link_dispatch_id)
  ) x;
$$;

revoke all on function public.crm_click_was_active(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.crm_click_was_active(uuid, uuid, timestamptz) to service_role;
revoke all on function public.crm_direct_deposits(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.crm_direct_deposits(uuid, timestamptz) to service_role;

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
    sent, failed, cost, recipients, human_clicks, converted_clicks,
    direct_conversions, direct_players, direct_revenue,
    direct_active_conversions, direct_active_players, direct_active_revenue,
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
           0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from sends group by 1, 2, 4, 5
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
  direct_agg as (
    select o.source_type, o.source_key, max(o.source_id::text)::uuid source_id, o.step_position, o.player_state,
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           count(*) filter (where not d.was_active) direct_conversions,
           -- A player converted by one SMS counts once, on the day of the first deposit.
           count(distinct d.player_id) filter (where not d.was_active and d.is_first) direct_players,
           coalesce(sum(d.monetary_value) filter (where not d.was_active), 0) direct_revenue,
           count(*) filter (where d.was_active) direct_active_conversions,
           count(distinct d.player_id) filter (where d.was_active) direct_active_players,
           coalesce(sum(d.monetary_value) filter (where d.was_active), 0) direct_active_revenue,
           0 influenced_players, 0 influenced_deposits, 0::numeric influenced_revenue
    from direct_deps d
    join dispatch_origin o on o.id = d.link_dispatch_id
    where d.occurred_at >= v_from and d.occurred_at < v_to
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
           0 sent, 0 failed, 0::numeric cost, 0 recipients, 0 human_clicks, 0 converted_clicks,
           0 direct_conversions, 0 direct_players, 0::numeric direct_revenue,
           0 direct_active_conversions, 0 direct_active_players, 0::numeric direct_active_revenue,
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
         sum(sent), sum(failed), sum(cost), sum(recipients), sum(human_clicks), sum(converted_clicks),
         sum(direct_conversions), sum(direct_players), sum(direct_revenue),
         sum(direct_active_conversions), sum(direct_active_players), sum(direct_active_revenue),
         sum(influenced_players), sum(influenced_deposits), sum(influenced_revenue),
         3, now()
  from all_parts
  group by source_type, source_key, step_position, player_state;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_crm_results_day(uuid, date) to service_role;

-- Distinct converted players of a period (BRT days), for the period totals:
-- the daily rows count a player once per day, origin and SMS.
create or replace function public.crm_click_players_period(_tenant uuid, _from date, _to date)
returns table (converted_players bigint, active_players bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct d.player_id) filter (where not d.was_active and d.is_first),
         count(distinct d.player_id) filter (where d.was_active)
  from public.crm_direct_deposits(
         _tenant, (_from::timestamp at time zone 'America/Sao_Paulo') - interval '8 days') d
  where (public.has_tenant_access(_tenant) or auth.role() = 'service_role')
    and d.occurred_at >= (_from::timestamp at time zone 'America/Sao_Paulo')
    and d.occurred_at < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo');
$$;

revoke all on function public.crm_click_players_period(uuid, date, date) from public, anon;
grant execute on function public.crm_click_players_period(uuid, date, date) to authenticated, service_role;

-- Consistency check: every direct attribution is either a conversion or a
-- deposit of a player already active.
create or replace function public.check_crm_results_day(_tenant uuid, _day date)
returns integer -- failed checks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := (_day::timestamp at time zone 'America/Sao_Paulo');
  v_to timestamptz := ((_day + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_price numeric;
  v_table record;
  v_raw_sent numeric;
  v_raw_cost numeric;
  v_raw_direct numeric;
  v_failed integer := 0;
  v_ok boolean;
begin
  select coalesce(
    (select sale_price_per_sms from public.tenant_sms_pricing where tenant_id = _tenant),
    (select default_sale_price_per_sms from public.sms_credit_settings limit 1),
    0.12
  ) into v_price;

  select coalesce(sum(sent), 0) sent, coalesce(sum(cost), 0) cost,
         coalesce(sum(direct_conversions + direct_active_conversions), 0) direct
    into v_table
  from public.crm_results_daily
  where tenant_id = _tenant and metric_date = _day;

  select count(*) into v_raw_sent
  from public.sms_send_logs
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and status in ('sent', 'delivered', 'enviado', 'entregue');

  -- Credits charged at the current price, the same price the table uses.
  select coalesce(sum(-delta_credits), 0) * v_price into v_raw_cost
  from public.sms_credit_ledger
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and entry_type in ('sms_reservation', 'sms_refund');

  select count(*) into v_raw_direct
  from public.conversion_attributions
  where tenant_id = _tenant and occurred_at >= v_from and occurred_at < v_to
    and classification = 'direct' and event_type = 'deposit_approved';

  v_ok := abs(v_table.sent - v_raw_sent) <= greatest(1, 0.01 * v_raw_sent);
  insert into public.crm_results_health values (_tenant, _day, 'sends', v_raw_sent, v_table.sent, v_ok, now())
  on conflict (tenant_id, metric_date, check_name) do update
    set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
  v_failed := v_failed + (not v_ok)::int;

  -- Tenants without a credit ledger have nothing to reconcile the cost with.
  if v_raw_cost > 0 then
    v_ok := abs(v_table.cost - v_raw_cost) <= greatest(v_price, 0.02 * v_raw_cost);
    insert into public.crm_results_health values (_tenant, _day, 'cost', v_raw_cost, v_table.cost, v_ok, now())
    on conflict (tenant_id, metric_date, check_name) do update
      set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
    v_failed := v_failed + (not v_ok)::int;
  end if;

  v_ok := abs(v_table.direct - v_raw_direct) <= greatest(1, 0.02 * v_raw_direct);
  insert into public.crm_results_health values (_tenant, _day, 'direct', v_raw_direct, v_table.direct, v_ok, now())
  on conflict (tenant_id, metric_date, check_name) do update
    set expected = excluded.expected, actual = excluded.actual, ok = excluded.ok, checked_at = now();
  v_failed := v_failed + (not v_ok)::int;

  return v_failed;
end;
$$;

revoke all on function public.check_crm_results_day(uuid, date) from public, anon, authenticated;
grant execute on function public.check_crm_results_day(uuid, date) to service_role;

-- Journey cards: "recovered" is the click revenue of players who were not
-- active at the click, the same rule as the Central de Resultados.
CREATE OR REPLACE FUNCTION public.list_journey_metrics(p_tenant_id uuid)
RETURNS TABLE (journey_id uuid, metrics jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH enrollment AS MATERIALIZED (
    SELECT journey_id, status::text AS status, exit_reason, current_position
    FROM public.journey_enrollments
    WHERE tenant_id = p_tenant_id
  ),
  totals AS (
    SELECT journey_id, count(*)::integer AS total FROM enrollment GROUP BY journey_id
  ),
  by_status AS (
    SELECT journey_id, jsonb_object_agg(status, amount) AS value
    FROM (SELECT journey_id, status, count(*)::integer AS amount FROM enrollment GROUP BY journey_id, status) grouped
    GROUP BY journey_id
  ),
  exits AS (
    SELECT journey_id, jsonb_object_agg(exit_reason, amount) AS value
    FROM (
      SELECT journey_id, exit_reason, count(*)::integer AS amount FROM enrollment
      WHERE exit_reason IS NOT NULL GROUP BY journey_id, exit_reason
    ) grouped GROUP BY journey_id
  ),
  positions AS (
    SELECT journey_id, jsonb_object_agg(current_position::text, amount) AS value
    FROM (
      SELECT journey_id, current_position, count(*)::integer AS amount FROM enrollment
      WHERE status IN ('active', 'waiting', 'paused_by_priority')
      GROUP BY journey_id, current_position
    ) grouped GROUP BY journey_id
  ),
  sent AS (
    SELECT journey_id, jsonb_object_agg(channel, amount) AS value
    FROM (
      SELECT journey_id, COALESCE(channel, 'other') AS channel, count(*)::integer AS amount
      FROM public.journey_step_executions
      WHERE tenant_id = p_tenant_id AND status IN ('sent', 'delivered')
      GROUP BY journey_id, COALESCE(channel, 'other')
    ) grouped GROUP BY journey_id
  ),
  attributed_recovery AS (
    SELECT source_id AS journey_id, COALESCE(sum(monetary_value), 0) AS recovered
    FROM public.crm_direct_deposits(p_tenant_id)
    WHERE source_type = 'journey' AND NOT was_active
    GROUP BY source_id
  )
  SELECT journey.id, jsonb_build_object(
    'total', COALESCE(totals.total, 0),
    'byStatus', COALESCE(by_status.value, '{}'::jsonb),
    'exits', COALESCE(exits.value, '{}'::jsonb),
    'positions', COALESCE(positions.value, '{}'::jsonb),
    'recovered', COALESCE(attributed_recovery.recovered, 0),
    'sentByChannel', COALESCE(sent.value, '{}'::jsonb)
  )
  FROM public.journeys journey
  LEFT JOIN totals ON totals.journey_id = journey.id
  LEFT JOIN by_status ON by_status.journey_id = journey.id
  LEFT JOIN exits ON exits.journey_id = journey.id
  LEFT JOIN positions ON positions.journey_id = journey.id
  LEFT JOIN sent ON sent.journey_id = journey.id
  LEFT JOIN attributed_recovery ON attributed_recovery.journey_id = journey.id
  WHERE journey.tenant_id = p_tenant_id;
$$;

REVOKE ALL ON FUNCTION public.list_journey_metrics(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_journey_metrics(uuid) TO service_role;
