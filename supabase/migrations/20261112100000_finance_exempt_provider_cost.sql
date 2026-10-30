-- Financeiro (ajustes 2026-10-29): provider cost for exempt houses.
--
-- Exempt houses (plan with billing_plans.exempt_all, see
-- public.billing_tenant_exempt in 20261022100000_billing_price_book.sql)
-- reserve with amount = 0, so finance_betleads_usage (from
-- 20261103100000_finance_dashboard.sql) showed them as costing nothing. Every
-- ledger row still records `units` and `provider_unit_cost` (refund rows carry
-- the returned units and the reservation's provider_unit_cost; see
-- wallet_refund in 20261022100100_billing_wallet.sql and wallet_settle in
-- 20261024100000_billing_wallet_settle.sql), so for those houses the daily
-- cost is what the provider charged:
--   sum(reservation units x provider_unit_cost)
--   - sum(refund units x provider_unit_cost)
-- with a null units or provider_unit_cost counting as 0. Paying houses keep
-- -sum(amount). Same Sao Paulo day grouping and window filter as before.
--
-- Known limitation (accepted): exemption is the house's CURRENT plan, applied
-- to every past day.

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
  with houses as (
    -- distinct: a tenant listed twice must not double its rows in the join.
    select t.id, public.billing_tenant_exempt(t.id) as exempt
    from (select distinct unnest(_tenants) as id) t
  )
  select
    wl.tenant_id,
    (wl.created_at at time zone 'America/Sao_Paulo')::date as metric_date,
    sum(
      case
        when not h.exempt then -wl.amount
        when wl.entry_type = 'usage_reservation'
          then coalesce(wl.units, 0) * coalesce(wl.provider_unit_cost, 0)
        else -(coalesce(wl.units, 0) * coalesce(wl.provider_unit_cost, 0))
      end
    ) as amount
  from public.wallet_ledger wl
  join houses h on h.id = wl.tenant_id
  where wl.tenant_id = any(_tenants)
    and wl.entry_type in ('usage_reservation', 'usage_refund')
    and wl.created_at >= (_from::timestamp at time zone 'America/Sao_Paulo')
    and wl.created_at < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  group by wl.tenant_id, (wl.created_at at time zone 'America/Sao_Paulo')::date
$$;

revoke all on function public.finance_betleads_usage(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_betleads_usage(uuid[], date, date) to service_role;

-- Whether each house is exempt now (billing_tenant_exempt), one row per
-- distinct house: the server uses it to label the tenant's Betleads cost line
-- "Custo de envio (provedor)".
create or replace function public.finance_tenants_exempt(_tenants uuid[])
returns table (
  tenant_id uuid,
  exempt boolean
)
language sql
stable security definer
set search_path = public
as $$
  select t.id as tenant_id, public.billing_tenant_exempt(t.id) as exempt
  from (select distinct unnest(_tenants) as id) t
$$;

revoke all on function public.finance_tenants_exempt(uuid[]) from public, anon, authenticated;
grant execute on function public.finance_tenants_exempt(uuid[]) to service_role;
