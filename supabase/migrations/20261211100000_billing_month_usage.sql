-- Financeiro geral / CSV mensal (Task 6): aggregates one month's wallet usage
-- per house x item in SQL.
--
-- Why: loadMonthData (src/lib/billing/billing-month-data.server.ts) paged the
-- month's raw wallet_ledger usage rows 1000 at a time. Measured in production
-- on 2026-11-05 (read-only), 2026-10 has ~330k such rows and took ~50 s to
-- load; the same GROUP BY in SQL takes ~0.4 s (parallel seq scan, ~12k
-- buffers). The app now calls this function and only falls back to the paged
-- read when the function does not exist yet.
--
-- Only adds a function (no table, column or index change): safe to apply
-- before or after the app deploy.
--
-- Over usage_reservation/usage_refund rows with usage_month = _month, grouped
-- by tenant_id, item (sign = +1 reservation, -1 refund):
--   units              = sum(sign x coalesce(units, 0))
--   sale_amount        = -sum(amount)  (the CSV's consumo per item)
--   provider_cost      = sum(sign x coalesce(units, 0) x provider_unit_cost),
--                        only over rows with a provider_unit_cost
--   missing_cost_units = sum(sign x coalesce(units, 0)), only over rows whose
--                        provider_unit_cost is null
create or replace function public.billing_month_usage(_month date)
returns table (
  tenant_id uuid,
  item text,
  units numeric,
  sale_amount numeric,
  provider_cost numeric,
  missing_cost_units numeric
)
language sql
stable security definer
set search_path = public
as $$
  with ledger_rows as (
    select
      wl.tenant_id,
      wl.item,
      case
        when wl.entry_type = 'usage_reservation' then coalesce(wl.units, 0)
        else -coalesce(wl.units, 0)
      end::numeric as signed_units,
      wl.amount,
      wl.provider_unit_cost
    from public.wallet_ledger wl
    where wl.usage_month = _month
      and wl.entry_type in ('usage_reservation', 'usage_refund')
  )
  select
    tenant_id,
    item,
    sum(signed_units) as units,
    -sum(amount) as sale_amount,
    coalesce(
      sum(signed_units * provider_unit_cost) filter (where provider_unit_cost is not null),
      0
    ) as provider_cost,
    coalesce(sum(signed_units) filter (where provider_unit_cost is null), 0) as missing_cost_units
  from ledger_rows
  group by tenant_id, item
$$;

revoke all on function public.billing_month_usage(date) from public, anon, authenticated;
grant execute on function public.billing_month_usage(date) to service_role;
