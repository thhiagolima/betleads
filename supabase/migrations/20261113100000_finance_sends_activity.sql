-- Financeiro (redesign do painel, Task 1): sends by channel and daily
-- activity, for the new per-house finance panel.
--
-- finance_send_usage: one row per house x Sao Paulo day x item, over
-- usage_reservation/usage_refund wallet_ledger rows. Same window filter and
-- distinct-tenant handling as finance_betleads_usage (20261112100000):
--   units = sum(reservation units) - sum(refund units)
--   amount, paying house:   -sum(amount), over every row regardless of cost
--   amount, exempt house:   sum(+-units x provider_unit_cost), only over
--                           rows that carry a provider_unit_cost
--   missing_cost_units:     for an exempt house, the net units of rows
--                           whose provider_unit_cost is null (0 for a
--                           paying house, since it never needs the cost)
-- This splits finance_betleads_usage's single amount by item/channel; that
-- function is left untouched (the server stops calling it in Task 3).
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
  with houses as (
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

-- finance_activity_days: one row per house x day (generate_series, like
-- finance_days, 20261101100100), left-joined and coalesced to 0:
--   deposit/depositor/withdrawal/pix counts  tenant_daily_metrics
--   crm_sent/crm_clicks/...                  sum(crm_results_daily) per day
--   ad_impressions/ad_clicks                 sum(marketing_ad_metrics_daily)
--                                             where provider = 'meta'
create or replace function public.finance_activity_days(_tenants uuid[], _from date, _to date)
returns table (
  tenant_id uuid,
  metric_date date,
  deposit_count int,
  depositor_count int,
  withdrawal_count int,
  generated_pix_count int,
  crm_sent int,
  crm_clicks int,
  crm_direct_conversions int,
  crm_direct_revenue numeric,
  crm_influenced_revenue numeric,
  ad_impressions bigint,
  ad_clicks bigint
)
language sql
stable security definer
set search_path = public
as $$
  with days as (
    -- distinct: a tenant listed twice must not double its rows below.
    select t.id as tenant_id, d::date as metric_date
    from (select distinct unnest(_tenants) as id) t
    cross join generate_series(_from::timestamp, _to::timestamp, interval '1 day') as d
  ),
  crm as (
    select
      tenant_id,
      metric_date,
      sum(sent) as crm_sent,
      sum(human_clicks) as crm_clicks,
      sum(direct_conversions) as crm_direct_conversions,
      sum(direct_revenue) as crm_direct_revenue,
      sum(influenced_revenue) as crm_influenced_revenue
    from public.crm_results_daily
    where tenant_id = any(_tenants)
      and metric_date between _from and _to
    group by tenant_id, metric_date
  ),
  ads as (
    select
      tenant_id,
      metric_date,
      sum(impressions) as ad_impressions,
      sum(coalesce(link_clicks, clicks)) as ad_clicks
    from public.marketing_ad_metrics_daily
    where provider = 'meta'
      and tenant_id = any(_tenants)
      and metric_date between _from and _to
    group by tenant_id, metric_date
  )
  select
    days.tenant_id,
    days.metric_date,
    coalesce(m.approved_deposit_count, 0) as deposit_count,
    coalesce(m.approved_depositor_count, 0) as depositor_count,
    coalesce(m.approved_withdrawal_count, 0) as withdrawal_count,
    coalesce(m.generated_pix_count, 0) as generated_pix_count,
    coalesce(crm.crm_sent, 0) as crm_sent,
    coalesce(crm.crm_clicks, 0) as crm_clicks,
    coalesce(crm.crm_direct_conversions, 0) as crm_direct_conversions,
    coalesce(crm.crm_direct_revenue, 0) as crm_direct_revenue,
    coalesce(crm.crm_influenced_revenue, 0) as crm_influenced_revenue,
    coalesce(ads.ad_impressions, 0) as ad_impressions,
    coalesce(ads.ad_clicks, 0) as ad_clicks
  from days
  left join public.tenant_daily_metrics m
    on m.tenant_id = days.tenant_id and m.metric_date = days.metric_date
  left join crm
    on crm.tenant_id = days.tenant_id and crm.metric_date = days.metric_date
  left join ads
    on ads.tenant_id = days.tenant_id and ads.metric_date = days.metric_date
  order by days.tenant_id, days.metric_date
$$;

revoke all on function public.finance_activity_days(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_activity_days(uuid[], date, date) to service_role;
