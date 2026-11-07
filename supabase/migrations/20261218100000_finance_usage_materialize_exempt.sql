-- Financeiro do grupo: "canceling statement due to statement timeout" (2026-11-07).
--
-- finance_send_usage and finance_betleads_usage join wallet_ledger to a
-- `houses` CTE carrying public.billing_tenant_exempt(id). Postgres inlines
-- that CTE, so the exempt lookup ran once per ledger row instead of once per
-- house: for Grupo Culiacam (7 houses, 12-month chart span, ~354k ledger
-- rows) finance_send_usage took ~9 s, over the 8 s PostgREST timeout.
-- MATERIALIZED evaluates the CTE once (7 rows) and cut the same query to
-- ~0.6 s with identical output. Bodies are otherwise unchanged from
-- 20261114100000_finance_sends_activity.sql and
-- 20261112100000_finance_exempt_provider_cost.sql.

create or replace function public.finance_send_usage(_tenants uuid[], _from date, _to date)
returns table (
  tenant_id uuid,
  metric_date date,
  item text,
  units bigint,
  amount numeric,
  missing_cost_units bigint
)
language sql
stable security definer
set search_path = public
as $$
  with houses as materialized (
    -- distinct: a tenant listed twice must not double its rows in the join.
    select t.id, public.billing_tenant_exempt(t.id) as exempt
    from (select distinct unnest(_tenants) as id) t
  ),
  ledger_rows as (
    select
      wl.tenant_id,
      (wl.created_at at time zone 'America/Sao_Paulo')::date as metric_date,
      wl.item,
      case
        when wl.entry_type = 'usage_reservation' then coalesce(wl.units, 0)
        else -coalesce(wl.units, 0)
      end as signed_units,
      wl.amount,
      wl.provider_unit_cost,
      h.exempt
    from public.wallet_ledger wl
    join houses h on h.id = wl.tenant_id
    where wl.tenant_id = any(_tenants)
      and wl.entry_type in ('usage_reservation', 'usage_refund')
      and wl.created_at >= (_from::timestamp at time zone 'America/Sao_Paulo')
      and wl.created_at < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  )
  select
    tenant_id,
    metric_date,
    item,
    sum(signed_units) as units,
    sum(
      case
        when not exempt then -amount
        when provider_unit_cost is not null then signed_units * provider_unit_cost
        else 0
      end
    ) as amount,
    sum(
      case
        when exempt and provider_unit_cost is null then signed_units
        else 0
      end
    ) as missing_cost_units
  from ledger_rows
  group by tenant_id, metric_date, item
$$;

revoke all on function public.finance_send_usage(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_send_usage(uuid[], date, date) to service_role;

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
  with houses as materialized (
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
