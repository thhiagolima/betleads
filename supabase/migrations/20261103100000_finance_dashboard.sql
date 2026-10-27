-- Financeiro redesign (Task 1): Betleads' own cost per house, surfaced in the
-- redesigned "Financeiro" results dashboard (see
-- docs/superpowers/sdd/2026-10-27-financeiro-painel). Three read functions
-- over real billing data (wallet_ledger from 20261022100100_billing_wallet.sql
-- and billing_invoices from 20261023100000_billing_invoices.sql), plus a free
-- -form category on the existing "other costs" table
-- (tenant_finance_other_costs, from 20261101100100_tenant_finance.sql).
--
-- All three functions are service_role only (same pattern as finance_days in
-- 20261101100100_tenant_finance.sql): they synthesize rows over an arbitrary
-- tenant set and must not be reachable through RLS directly.

alter table public.tenant_finance_other_costs
  add column if not exists categoria text null
    check (categoria is null or length(btrim(categoria)) between 1 and 60);

-- Daily net usage cost (what Betleads spent serving the house that day):
-- usage_reservation amounts are negative, usage_refund amounts are positive
-- (wallet_ledger convention), so -sum(amount) over both entry types is the
-- net cost, with a refund landing on the day it happened, not the day of the
-- reservation it reverses. One row per house x Sao Paulo day that has at
-- least one usage row in the window; a day with none is simply absent (the
-- caller fills zeros, matching finance_days' later join pattern).
create or replace function public.finance_betleads_usage(_tenants uuid[], _from date, _to date)
returns table (
  tenant_id uuid,
  metric_date date,
  amount numeric
)
language sql
stable security definer
set search_path = public
as $$
  select
    wl.tenant_id,
    (wl.created_at at time zone 'America/Sao_Paulo')::date as metric_date,
    -sum(wl.amount) as amount
  from public.wallet_ledger wl
  where wl.tenant_id = any(_tenants)
    and wl.entry_type in ('usage_reservation', 'usage_refund')
    and wl.created_at >= (_from::timestamp at time zone 'America/Sao_Paulo')
    and wl.created_at < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  group by wl.tenant_id, (wl.created_at at time zone 'America/Sao_Paulo')::date
$$;

revoke all on function public.finance_betleads_usage(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_betleads_usage(uuid[], date, date) to service_role;

-- Monthly plan fee (what the house owes/owed Betleads for the plan), by the
-- month of the invoice's period_start, for both bounds inclusive. Only open
-- and paid invoices count (canceled never happened); amount_cents is
-- converted to reais.
create or replace function public.finance_betleads_fees(_tenants uuid[], _from_month date, _to_month date)
returns table (
  tenant_id uuid,
  month date,
  amount numeric
)
language sql
stable security definer
set search_path = public
as $$
  select
    bi.tenant_id,
    date_trunc('month', bi.period_start)::date as month,
    sum(bi.amount_cents) / 100.0 as amount
  from public.billing_invoices bi
  where bi.tenant_id = any(_tenants)
    and bi.status in ('open', 'paid')
    and date_trunc('month', bi.period_start)::date between
      date_trunc('month', _from_month)::date and date_trunc('month', _to_month)::date
  group by bi.tenant_id, date_trunc('month', bi.period_start)::date
$$;

revoke all on function public.finance_betleads_fees(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_betleads_fees(uuid[], date, date) to service_role;

-- Earliest Sao Paulo date among a house's usage ledger rows and its
-- invoices' period_start: how far back the dashboard can show Betleads cost
-- for that house. A house with neither has no row (there is nothing to show
-- a "since" date for). Only open/paid invoices count, same as
-- finance_betleads_fees, so a canceled invoice (which never happened) never
-- anchors "since".
create or replace function public.finance_betleads_since(_tenants uuid[])
returns table (
  tenant_id uuid,
  since date
)
language sql
stable security definer
set search_path = public
as $$
  select t.id as tenant_id, min(d.d) as since
  from unnest(_tenants) as t(id)
  join lateral (
    select (wl.created_at at time zone 'America/Sao_Paulo')::date as d
    from public.wallet_ledger wl
    where wl.tenant_id = t.id and wl.entry_type in ('usage_reservation', 'usage_refund')
    union all
    select bi.period_start as d
    from public.billing_invoices bi
    where bi.tenant_id = t.id and bi.status in ('open', 'paid')
  ) d on true
  group by t.id
$$;

revoke all on function public.finance_betleads_since(uuid[]) from public, anon, authenticated;
grant execute on function public.finance_betleads_since(uuid[]) to service_role;
