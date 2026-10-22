-- PG1 final review fixes:
--   1. dashboard_summary_v2 stops reading the legacy credit ledger/balance
--      (tenant_sms_credit_balances, sms_credit_ledger, the 0.12 fallback) for
--      smsSent/messageCost/smsCredits. It's copied whole from the latest
--      definition (20261019150000_conversion_reports_exclude_active.sql) with
--      three changes: smsSent/messageCost now come from crm_results_daily
--      (already on the price book and billed_units, Task 6), and the legacy
--      credit balance field is replaced by the wallet balance
--      (tenant_wallets.balance, 0 when the house has no row yet) plus an
--      `exempt` flag (billing_tenant_exempt). The signature, grants and every
--      other field are unchanged.
--   3. billing_report_unit_price is redefined whole (copied from
--      20261022100000_billing_price_book.sql) so a demo house
--      (tenants.is_demo = true) reports the SALE unit_price, not the
--      supplier's cost: the demo house is a sales/support tool, so its
--      "cost" in internal reports should look like what a paying house would
--      see. A real `interno` house that isn't the demo tenant still reports
--      the supplier cost (unchanged behavior, the 3 slugs from Task 2). EXECUTE
--      is also revoked from `authenticated` -- every caller in the codebase
--      reads this RPC through supabaseAdmin (service_role) in
--      src/lib/billing/pricing.server.ts, never from a browser session, and
--      it's a plain numeric that never redacts provider_unit_cost, so it must
--      not be reachable by a signed-in house user directly.

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
-- D-04: what the tenant was charged for SMS in the period, from the Central
-- de Resultados' own daily rollup (already on the price book and
-- billed_units -- segments, not sends -- since Task 6). Replaces the legacy
-- credit-ledger-or-flat-price computation.
sms_results as (
  select coalesce(sum(d.sent),0)::int sent,
         coalesce(sum(d.cost),0)::numeric cost
  from public.crm_results_daily d, bounds
  where d.tenant_id = _tenant
    and d.metric_date between (cur_from at time zone 'America/Sao_Paulo')::date
                          and (cur_to at time zone 'America/Sao_Paulo')::date
),
-- Wallet balance (0 when the house has no row yet) and the `interno`
-- exemption flag, replacing the legacy tenant_sms_credit_balances field.
wallet as (
  select coalesce((select w.balance from public.tenant_wallets w where w.tenant_id = _tenant), 0)::numeric balance,
         public.billing_tenant_exempt(_tenant) exempt
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
        and e.status in ('active','waiting','paused_by_priority')) reactivation_queue
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
  'smsSent', sr.sent,
  'messageCost', sr.cost,
  'pausedFlows', f.paused,
  'walletBalance', w.balance,
  'exempt', w.exempt,
  'pixGenerated', c.pix_generated,
  'previousPixGenerated', p.pix_generated,
  'reactivationQueue', o.reactivation_queue,
  'activeFlows', f.active,
  'totalFlows', f.total,
  'cashflowChart', se.value,
  'liveEvents', l.value
)
from guard, cur_daily c, prev_daily p, cur_depositors cd, prev_depositors pd,
     cur_redeposits cr, prev_redeposits pr, recovered r, sms_results sr, wallet w,
     flow_counts f, series se, live l, other o
where guard.ok;
$$;

revoke all on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.dashboard_summary_v2(uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated, service_role;

-- billing_report_unit_price: copied whole from 20261022100000_billing_price_book.sql.
-- Only change: a demo house (tenants.is_demo = true) reports the sale
-- unit_price instead of the supplier cost, so demos look like a paying
-- house in internal reports. A real `interno` house (not the demo tenant)
-- keeps reporting the supplier cost, unchanged.
create or replace function public.billing_report_unit_price(
  _tenant uuid,
  _item text,
  _at timestamptz default now()
)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_default public.billing_price_book%rowtype;
  v_override public.tenant_price_overrides%rowtype;
  v_unit_price numeric(12,4);
  v_is_demo boolean;
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_default
  from public.billing_price_book
  where item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  select * into v_override
  from public.tenant_price_overrides
  where tenant_id = _tenant and item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  v_unit_price := coalesce(v_override.unit_price, v_default.unit_price);

  select coalesce(t.is_demo, false) into v_is_demo
  from public.tenants t where t.id = _tenant;

  if public.billing_tenant_exempt(_tenant) and not coalesce(v_is_demo, false) then
    return coalesce(v_default.provider_unit_cost, v_unit_price);
  end if;

  return v_unit_price;
end;
$$;

revoke execute on function public.billing_report_unit_price(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_report_unit_price(uuid, text, timestamptz) to service_role;

notify pgrst, 'reload schema';
