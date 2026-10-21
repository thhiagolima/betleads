-- PG1 Task 6: prices in the database reports. `refresh_crm_results_day`,
-- `check_crm_results_day` and `admin_list_users_with_usage` stop reading the
-- legacy flat-rate fallback / old per-channel pricing table and read
-- `billing_price_book` (via `billing_report_unit_price`, Task 2) instead.
-- SMS cost also switches from "1 unit per accepted send" to
-- `sms_send_logs.billed_units` (segments reserved from the wallet, Task 5;
-- null on rows sent before that, which are worth 1 unit).
--
-- Production rebuild note: after this migration is applied, the cutover
-- runbook (Task 9) refreshes (public.refresh_crm_results_day) the last 30
-- days of crm_results_daily so the historical cost column reflects the new
-- price book and billed_units instead of the price snapshot at the time
-- each day was first computed.

-- Old rows were sent before billed_units existed; they are worth 1 unit.
alter table public.sms_send_logs
  add column if not exists billed_units smallint null;

-- `refresh_crm_results_day`: copied whole from
-- 20261019120000_crm_click_conversion_incremental.sql. Only the SMS price
-- source and the "sends" cost change: the price comes from
-- billing_report_unit_price('sms') instead of the old tenant/global SMS
-- price settings, and the cost sums billed_units (segments) instead of
-- counting 1 unit per accepted send.
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
  v_price := public.billing_report_unit_price(_tenant, 'sms', v_from);

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
           s.billed_units,
           s.status in ('sent', 'delivered', 'enviado', 'entregue') is_sent,
           s.status in ('error', 'erro', 'failed') is_failed
    from public.sms_send_logs s
    cross join lateral public.crm_source_of_trigger(_tenant, s.trigger_name) src
    left join public.journey_step_executions x
      on src.source_type = 'journey' and x.idempotency_key::text = s.idempotency_key
    where s.tenant_id = _tenant and s.created_at >= v_from and s.created_at < v_to
  ),
  sends_agg as (
    select s.source_type, s.source_key, max(s.source_id::text)::uuid source_id, s.step_position, s.player_state,
           count(*) filter (where s.is_sent) sent,
           count(*) filter (where s.is_failed) failed,
           sum(coalesce(s.billed_units, 1)) filter (where s.is_sent) * v_price cost,
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

-- `check_crm_results_day`: copied whole from
-- 20261019120000_crm_click_conversion_incremental.sql (the latest; it
-- replaced the 20261016200000_sms_price_0059.sql version, which already
-- superseded the original definition in 20261016190000_crm_results_health.sql).
-- Only the raw cost source changes: the price comes from
-- billing_report_unit_price('sms') instead of the old tenant/global SMS
-- price settings, and the raw cost sums both ledgers that can
-- have charged SMS that day: wallet_ledger (units reserved minus units
-- refunded, Task 3+5) for sends on/after the cutover, and the legacy
-- sms_credit_ledger (unchanged) for sends from before it.
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
  v_wallet_units numeric;
  v_legacy_credits numeric;
  v_raw_direct numeric;
  v_failed integer := 0;
  v_ok boolean;
begin
  v_price := public.billing_report_unit_price(_tenant, 'sms', v_from);

  select coalesce(sum(sent), 0) sent, coalesce(sum(cost), 0) cost,
         coalesce(sum(direct_conversions + direct_active_conversions), 0) direct
    into v_table
  from public.crm_results_daily
  where tenant_id = _tenant and metric_date = _day;

  select count(*) into v_raw_sent
  from public.sms_send_logs
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and status in ('sent', 'delivered', 'enviado', 'entregue');

  -- New ledger: SMS units reserved minus units refunded that day.
  select coalesce(sum(units) filter (where entry_type = 'usage_reservation'), 0)
       - coalesce(sum(units) filter (where entry_type = 'usage_refund'), 0)
    into v_wallet_units
  from public.wallet_ledger
  where tenant_id = _tenant and item = 'sms'
    and created_at >= v_from and created_at < v_to
    and entry_type in ('usage_reservation', 'usage_refund');

  -- Legacy ledger: credits reserved minus refunded that day (unchanged
  -- formula from before the cutover: refund deltas are positive, so summing
  -- -delta_credits over both entry types nets reservations minus refunds).
  select coalesce(sum(-delta_credits), 0) into v_legacy_credits
  from public.sms_credit_ledger
  where tenant_id = _tenant and created_at >= v_from and created_at < v_to
    and entry_type in ('sms_reservation', 'sms_refund');

  -- Credits/units charged at the current price, the same price the table uses.
  v_raw_cost := coalesce(v_wallet_units, 0) * v_price + coalesce(v_legacy_credits, 0) * v_price;

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

-- `admin_list_users_with_usage`: copied whole from
-- 20261003133000_fix_admin_user_directory_call_duration.sql. Only the price
-- source changes: the old per-channel pricing table is replaced by
-- billing_price_book's current default unit_price (latest valid_from <=
-- now()) for sms/email, and voice billing switches from "price per minute x
-- total minutes" to "price per 30s segment x ceil(duration_seconds/30) per
-- call row, summed" (voice_30s price). call_minutes keeps the same meaning
-- (output columns are unchanged).
create or replace function public.admin_list_users_with_usage(
  _from timestamptz default (now() - interval '30 days'),
  _to timestamptz default now()
)
returns table (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  banned_until timestamptz, tenant_id uuid, tenant_nome text, role text,
  sms_count bigint, sms_cost numeric, call_minutes numeric, call_cost numeric,
  email_count bigint, email_cost numeric, total_cost numeric
)
language plpgsql security definer set search_path to 'public'
as $$
declare v_sms numeric; v_call numeric; v_email numeric;
begin
  if not public.is_super_admin() then raise exception 'forbidden'; end if;

  select unit_price into v_sms from public.billing_price_book
  where item = 'sms' and valid_from <= now() order by valid_from desc limit 1;
  select unit_price into v_call from public.billing_price_book
  where item = 'voice_30s' and valid_from <= now() order by valid_from desc limit 1;
  select unit_price into v_email from public.billing_price_book
  where item = 'email' and valid_from <= now() order by valid_from desc limit 1;

  return query
  with memberships as (
    select distinct ur.user_id, ur.tenant_id, ur.role::text as role
    from public.user_roles ur
    where ur.tenant_id is not null and ur.role in ('admin', 'gestor', 'member')
  ), base as (
    select u.id as user_id, u.email::text as email, u.created_at, u.last_sign_in_at, u.banned_until,
      (array_agg(m.tenant_id order by m.tenant_id) filter (where m.tenant_id is not null))[1] as tenant_id,
      string_agg(distinct t.nome::text, ', ' order by t.nome::text) as tenant_nome,
      string_agg(distinct m.role, ', ' order by m.role) as role
    from auth.users u
    left join memberships m on m.user_id = u.id
    left join public.tenants t on t.id = m.tenant_id
    where not public.is_super_admin(u.id)
    group by u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until
  ), sms as (
    select m.user_id, count(*)::bigint as c
    from memberships m join public.sms_send_logs l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  ), calls as (
    select m.user_id,
      coalesce(sum(coalesce(l.duration_seconds, 0)::numeric / 60), 0)::numeric as minutes,
      coalesce(sum(ceil(coalesce(l.duration_seconds, 0)::numeric / 30.0)), 0)::numeric as units
    from memberships m join public.call_history l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  ), emails as (
    select m.user_id, count(*)::bigint as c
    from memberships m join public.email_send_logs l on l.tenant_id = m.tenant_id
    where l.created_at >= _from and l.created_at < _to group by m.user_id
  )
  select b.user_id, b.email, b.created_at, b.last_sign_in_at, b.banned_until,
    b.tenant_id, b.tenant_nome, b.role,
    coalesce(s.c,0), (coalesce(s.c,0)*coalesce(v_sms,0))::numeric,
    coalesce(c.minutes,0), (coalesce(c.units,0)*coalesce(v_call,0))::numeric,
    coalesce(e.c,0), (coalesce(e.c,0)*coalesce(v_email,0))::numeric,
    (coalesce(s.c,0)*coalesce(v_sms,0)+coalesce(c.units,0)*coalesce(v_call,0)+coalesce(e.c,0)*coalesce(v_email,0))::numeric
  from base b left join sms s on s.user_id=b.user_id
  left join calls c on c.user_id=b.user_id left join emails e on e.user_id=b.user_id
  order by b.email;
end;
$$;

revoke execute on function public.admin_list_users_with_usage(timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_list_users_with_usage(timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
