-- The click conversion rule of the Central de Resultados (rule_version 3,
-- 20261019120000) applied to every other CRM screen that shows conversions of
-- campaigns and journeys (docs/AUDITORIA_NUMEROS_RESULTADOS_CRM_2026-10-19.md, section 8):
--   * home dashboard        dashboard_summary_v2 recovered*
--   * report list           conversion_report_sources (new column active_revenue)
--   * campaign/journey report, drilldown, CSV and A/B test read the computed
--     column conversion_attributions.player_active_at_click (PostgREST).
-- A deposit counts only when the player had no approved deposit in the 48 h
-- before the first click on that SMS; the flag belongs to the SMS (dispatch),
-- so a player reactivated by a click keeps counting for the whole window.

create index if not exists conversion_attributions_dispatch_idx
  on public.conversion_attributions (tenant_id, link_dispatch_id);

-- Player of the dispatch already active at its first attributed click.
create or replace function public.crm_dispatch_was_active(_tenant uuid, _dispatch uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(public.crm_click_was_active(
           _tenant, min(a.player_id::text)::uuid, min(coalesce(a.window_started_at, a.occurred_at))), false)
  from public.conversion_attributions a
  where a.tenant_id = _tenant and a.link_dispatch_id = _dispatch
    and a.event_type = 'deposit_approved';
$$;

-- Same flags as before, now from the shared per-dispatch definition.
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
         public.crm_dispatch_was_active(_tenant, x.link_dispatch_id),
         x.position = 1
  from (
    select a.*,
           row_number() over (partition by a.link_dispatch_id order by a.occurred_at, a.id) position
    from public.conversion_attributions a
    where a.tenant_id = _tenant and a.classification = 'direct'
      and a.event_type = 'deposit_approved' and a.occurred_at >= _since
  ) x;
$$;

-- PostgREST computed column: select=...,player_active_at_click. Runs as the
-- caller, so row-level security on deposits and attributions still applies.
create or replace function public.player_active_at_click(public.conversion_attributions)
returns boolean
language sql
stable
set search_path = public
as $$
  select $1.event_type = 'deposit_approved'
     and public.crm_dispatch_was_active($1.tenant_id, $1.link_dispatch_id);
$$;

revoke all on function public.crm_click_was_active(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.crm_click_was_active(uuid, uuid, timestamptz) to authenticated, service_role;
revoke all on function public.crm_dispatch_was_active(uuid, uuid) from public, anon;
grant execute on function public.crm_dispatch_was_active(uuid, uuid) to authenticated, service_role;
revoke all on function public.player_active_at_click(public.conversion_attributions) from public, anon;
grant execute on function public.player_active_at_click(public.conversion_attributions) to authenticated, service_role;

-- Home dashboard: recovered = click deposits of players not already active.
create or replace function public.dashboard_summary_v2(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz,
  _prev_from timestamptz,
  _prev_to timestamptz,
  _reset_at timestamptz default '1970-01-01T00:00:00Z'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
bounds as (
  select greatest(_from, _reset_at) cur_from, _to cur_to,
         greatest(_prev_from, _reset_at) prev_from, _prev_to prev_to
),
cur_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(approved_withdrawal_amount),0)::numeric withdrawal_amount,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (cur_from at time zone 'America/Sao_Paulo')::date
                        and (cur_to at time zone 'America/Sao_Paulo')::date
),
prev_daily as (
  select coalesce(sum(registrations),0)::int registrations,
         coalesce(sum(ftds),0)::int ftds,
         coalesce(sum(approved_deposit_count),0)::int deposit_count,
         coalesce(sum(approved_deposit_amount),0)::numeric deposit_amount,
         coalesce(sum(generated_pix_count),0)::int pix_generated
  from public.tenant_daily_metrics, bounds
  where tenant_id = _tenant
    and metric_date between (prev_from at time zone 'America/Sao_Paulo')::date
                        and (prev_to at time zone 'America/Sao_Paulo')::date
),
cur_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between cur_from and cur_to
),
prev_depositors as (
  select count(distinct d.player_id)::int value
  from public.deposits d, bounds
  where d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
    and d.created_at between prev_from and prev_to
),
cur_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount, count(*)::int count,
         count(distinct d.player_id)::int players
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between cur_from and cur_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
prev_redeposits as (
  select coalesce(sum(d.valor),0)::numeric amount
  from public.deposits d
  join public.players p on p.id = d.player_id and p.tenant_id = d.tenant_id
  cross join bounds
  where d.tenant_id = _tenant and d.status = 'aprovado'
    and d.created_at between prev_from and prev_to
    and p.ftd_em is not null and d.created_at > p.ftd_em + interval '1 minute'
),
-- D-01: deposits attributed to a campaign or journey by a human click (7-day
-- direct window, conversion_attributions). Manual follow-ups no longer count.
-- Players already active at the click are not a recovery (rule_version 3).
recovered as (
  select
    coalesce(sum(a.monetary_value),0)::numeric amount,
    count(distinct a.player_id)::int players,
    coalesce(sum(a.monetary_value) filter (where p.created_at >= b.cur_from),0)::numeric new_amount,
    coalesce(sum(a.monetary_value) filter (where a.source_type = 'journey'),0)::numeric reactivated_amount
  from public.conversion_attributions a
  left join public.players p on p.id = a.player_id
  cross join bounds b
  where a.tenant_id = _tenant and a.event_type = 'deposit_approved'
    and a.classification = 'direct'
    and a.occurred_at between b.cur_from and b.cur_to
    and not public.crm_dispatch_was_active(a.tenant_id, a.link_dispatch_id)
),
-- D-04: what the tenant was charged (credit reservations minus refunds at the
-- recorded unit price). Falls back to accepted SMS x the tenant price when the
-- tenant has no ledger.
sms_price as (
  select coalesce(
    (select sale_price_per_sms from public.tenant_sms_pricing where tenant_id = _tenant),
    (select default_sale_price_per_sms from public.sms_credit_settings limit 1),
    0.12
  )::numeric price
),
sms as (
  select
    coalesce(sum(-l.delta_credits) filter (where l.entry_type in ('sms_reservation','sms_refund')),0)::int ledger_sent,
    coalesce(sum(-l.delta_credits * coalesce(l.unit_sale_price, sp.price))
      filter (where l.entry_type in ('sms_reservation','sms_refund')),0)::numeric ledger_cost,
    count(*) filter (where l.entry_type in ('sms_reservation','sms_refund'))::int ledger_rows
  from bounds b
  cross join sms_price sp
  left join public.sms_credit_ledger l
    on l.tenant_id = _tenant and l.created_at between b.cur_from and b.cur_to
),
sms_logs as (
  select count(*) filter (where s.status in ('sent','delivered','enviado','entregue'))::int sent
  from public.sms_send_logs s, bounds
  where s.tenant_id = _tenant and s.created_at between cur_from and cur_to
),
-- D-05: the journeys engine, not the legacy sms_flows table.
flow_counts as (
  select count(*) filter (where status <> 'archived')::int total,
         count(*) filter (where status = 'active')::int active,
         count(*) filter (where status = 'paused')::int paused
  from public.journeys where tenant_id = _tenant
),
series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', to_char(day, 'YYYY-MM-DD'),
    'label', to_char(day, 'DD/MM'),
    'deposits', coalesce(m.approved_deposit_amount,0),
    'withdrawals', coalesce(m.approved_withdrawal_amount,0)
  ) order by day), '[]'::jsonb) value
  from bounds b
  cross join lateral generate_series(
    (b.cur_from at time zone 'America/Sao_Paulo')::date,
    (b.cur_to at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) day
  left join public.tenant_daily_metrics m
    on m.tenant_id = _tenant and m.metric_date = day::date
),
live as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.kind || '-' || x.id::text,
    'tone', x.tone,
    'player', coalesce(x.player_name, 'jogador'),
    'action', x.action,
    'amount', x.amount,
    'at', x.created_at
  ) order by x.created_at desc), '[]'::jsonb) value
  from (
    (select 'player' kind, p.id, 'blue' tone, p.nome player_name,
            'criou conta' action, null::numeric amount, p.created_at
     from public.players p where p.tenant_id = _tenant order by p.created_at desc limit 12)
    union all
    (select 'deposit', d.id, 'green', p.nome, 'depositou', d.valor, d.created_at
     from public.deposits d left join public.players p on p.id = d.player_id
     where d.tenant_id = _tenant and d.status = 'aprovado' order by d.created_at desc limit 12)
    union all
    (select 'withdrawal', w.id, 'purple', p.nome, 'sacou', w.valor, w.created_at
     from public.withdrawals w left join public.players p on p.id = w.player_id
     where w.tenant_id = _tenant and w.status = 'aprovado' order by w.created_at desc limit 12)
    union all
    (select 'event', e.id, 'orange', p.nome, 'gerou um PIX', e.valor, e.created_at
     from public.events e left join public.players p on p.id = e.player_id
     where e.tenant_id = _tenant
       and (lower(coalesce(e.tipo,'')) like '%pix%' or lower(coalesce(e.tipo,'')) like '%deposit%')
     order by e.created_at desc limit 8)
  ) x
  limit 8
),
-- D-06: distinct players inside a journey now (not "no login for 7 days").
other as (
  select
    (select count(distinct e.player_id)::int from public.journey_enrollments e
      where e.tenant_id = _tenant
        and e.status in ('active','waiting','paused_by_priority')) reactivation_queue,
    coalesce((select balance_credits from public.tenant_sms_credit_balances where tenant_id = _tenant),0)::int sms_credits
)
select jsonb_build_object(
  'depositAmount', c.deposit_amount,
  'previousDepositAmount', p.deposit_amount,
  'depositCount', c.deposit_count,
  'previousDepositCount', p.deposit_count,
  'depositors', cd.value,
  'previousDepositors', pd.value,
  'newPlayers', c.registrations,
  'previousNewPlayers', p.registrations,
  'ftd', c.ftds,
  'previousFtd', p.ftds,
  'withdrawalAmount', c.withdrawal_amount,
  'redepositAmount', cr.amount,
  'previousRedepositAmount', pr.amount,
  'redepositCount', cr.count,
  'redepositPlayers', cr.players,
  'recoveredAmount', r.amount,
  'recoveredPlayers', r.players,
  'recoveredNew', r.new_amount,
  'recoveredReactivated', r.reactivated_amount,
  'smsSent', case when s.ledger_rows > 0 then s.ledger_sent else sl.sent end,
  'messageCost', case when s.ledger_rows > 0 then s.ledger_cost
                      else sl.sent * (select price from sms_price) end,
  'pausedFlows', f.paused,
  'smsCredits', o.sms_credits,
  'pixGenerated', c.pix_generated,
  'previousPixGenerated', p.pix_generated,
  'reactivationQueue', o.reactivation_queue,
  'activeFlows', f.active,
  'totalFlows', f.total,
  'cashflowChart', se.value,
  'liveEvents', l.value
)
from guard, cur_daily c, prev_daily p, cur_depositors cd, prev_depositors pd,
     cur_redeposits cr, prev_redeposits pr, recovered r, sms s, sms_logs sl,
     flow_counts f, series se, live l, other o
where guard.ok;
$$;

revoke all on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated, service_role;

-- Report list: the return type gains active_revenue.
drop function if exists public.conversion_report_sources(uuid, timestamptz, timestamptz);

create or replace function public.conversion_report_sources(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz
)
returns table (
  source_type text,
  source_id uuid,
  sent bigint,
  delivered bigint,
  sms bigint,
  email bigint,
  whatsapp bigint,
  conversions bigint,
  direct_revenue numeric,
  assisted_revenue numeric,
  active_revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
with guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
messages as (
  -- One message = one log entry (or delivery key), whatever its link count.
  select d.source_type, d.source_id::uuid source_id,
         coalesce(d.message_log_id, regexp_replace(d.idempotency_key, ':[0-9]+$', '')) message_key,
         d.channel,
         bool_or(d.send_status = 'sent') is_sent,
         bool_or(d.delivery_status = 'delivered') is_delivered
  from public.link_dispatches d, guard
  where guard.ok
    and d.tenant_id = _tenant
    and d.source_type in ('campaign', 'journey')
    and d.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and d.sent_at between _from and _to
  group by 1, 2, 3, 4
),
sends as (
  select m.source_type, m.source_id,
         count(*) filter (where m.is_sent) sent,
         count(*) filter (where m.is_delivered) delivered,
         count(*) filter (where m.is_sent and m.channel = 'sms') sms,
         count(*) filter (where m.is_sent and m.channel = 'email') email,
         count(*) filter (where m.is_sent and m.channel = 'whatsapp') whatsapp
  from messages m
  group by 1, 2
),
-- Deposits of players already active at the click go to active_revenue only.
flagged as (
  select a.*, public.crm_dispatch_was_active(a.tenant_id, a.link_dispatch_id) was_active
  from public.conversion_attributions a, guard
  where guard.ok
    and a.tenant_id = _tenant
    and a.event_type = 'deposit_approved'
    and a.source_type in ('campaign', 'journey')
    and a.occurred_at between _from and _to
),
conv as (
  select a.source_type, a.source_id,
         count(*) filter (where a.classification = 'direct' and not a.was_active) conversions,
         coalesce(sum(a.monetary_value) filter (where a.classification = 'direct' and not a.was_active), 0) direct_revenue,
         coalesce(sum(a.monetary_value) filter (where a.classification = 'assisted' and not a.was_active), 0) assisted_revenue,
         coalesce(sum(a.monetary_value) filter (where a.classification = 'direct' and a.was_active), 0) active_revenue
  from flagged a
  group by 1, 2
)
select coalesce(s.source_type, c.source_type)::text as source_type,
       coalesce(s.source_id, c.source_id) as source_id,
       coalesce(s.sent, 0) as sent,
       coalesce(s.delivered, 0) as delivered,
       coalesce(s.sms, 0) as sms,
       coalesce(s.email, 0) as email,
       coalesce(s.whatsapp, 0) as whatsapp,
       coalesce(c.conversions, 0) as conversions,
       coalesce(c.direct_revenue, 0)::numeric as direct_revenue,
       coalesce(c.assisted_revenue, 0)::numeric as assisted_revenue,
       coalesce(c.active_revenue, 0)::numeric as active_revenue
from sends s
full join conv c on c.source_type = s.source_type and c.source_id = s.source_id;
$$;

revoke all on function public.conversion_report_sources(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.conversion_report_sources(uuid, timestamptz, timestamptz) to authenticated, service_role;
