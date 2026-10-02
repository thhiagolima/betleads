alter table public.meta_ad_accounts
  add column if not exists sync_status text not null default 'never'
    check (sync_status in ('never', 'queued', 'syncing', 'healthy', 'warning', 'error')),
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error text,
  add column if not exists last_row_count integer not null default 0;

create index if not exists meta_ad_accounts_health_idx
  on public.meta_ad_accounts (tenant_id, selected, sync_status, last_success_at desc);

-- O fluxo antigo usava o app compartilhado do CRM. Ele deixa de sincronizar até
-- que a operação conecte um token gerado pelo próprio app/Business Manager.
update public.meta_connections
set status = 'error',
    last_error = 'Conexão antiga: reconecte usando o app e o Usuário do Sistema da sua operação.'
where auth_type = 'legacy_oauth'
  and status = 'connected';

update public.meta_ad_accounts account
set selected = false,
    sync_status = 'warning',
    last_error = 'Conta vinculada à conexão antiga. Reconecte para voltar a sincronizar.'
from public.meta_connections connection
where connection.id = account.connection_id
  and connection.auth_type = 'legacy_oauth';

create or replace function public.reconcile_meta_attributions(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  with matches as (
    select
      attribution.id,
      coalesce(by_id.ad_account_id, by_name.ad_account_id, by_campaign.ad_account_id) as ad_account_id,
      coalesce(by_id.campaign_id, by_name.campaign_id, by_campaign.campaign_id) as campaign_id,
      coalesce(by_id.adset_id, by_name.adset_id, by_campaign.adset_id) as adset_id,
      coalesce(by_id.ad_id, by_name.ad_id) as ad_id,
      case
        when by_id.ad_id is not null then 'matched_ad_id'
        when by_name.ad_id is not null then 'matched_ad_name'
        when by_campaign.campaign_id is not null then 'matched_campaign_name'
        when coalesce(attribution.utm_id, attribution.utm_content, attribution.utm_campaign, attribution.utm_source) is null
          then 'missing_utm'
        else 'orphan_campaign'
      end as match_status,
      case
        when by_id.ad_id is not null then 100
        when by_name.ad_id is not null then 85
        when by_campaign.campaign_id is not null then 65
        else 0
      end as confidence
    from public.player_attributions attribution
    left join lateral (
      select metric.ad_account_id, metric.campaign_id, metric.adset_id, metric.ad_id
      from public.marketing_ad_metrics_daily metric
      where metric.tenant_id = attribution.tenant_id
        and metric.provider = 'meta'
        and attribution.utm_id is not null
        and lower(metric.ad_id) = lower(attribution.utm_id)
      order by metric.metric_date desc
      limit 1
    ) by_id on true
    left join lateral (
      select metric.ad_account_id, metric.campaign_id, metric.adset_id, metric.ad_id
      from public.marketing_ad_metrics_daily metric
      where metric.tenant_id = attribution.tenant_id
        and metric.provider = 'meta'
        and by_id.ad_id is null
        and attribution.utm_content is not null
        and lower(metric.ad_name) = lower(attribution.utm_content)
      order by metric.metric_date desc
      limit 1
    ) by_name on true
    left join lateral (
      select metric.ad_account_id, metric.campaign_id, metric.adset_id
      from public.marketing_ad_metrics_daily metric
      where metric.tenant_id = attribution.tenant_id
        and metric.provider = 'meta'
        and by_id.ad_id is null
        and by_name.ad_id is null
        and attribution.utm_campaign is not null
        and (
          lower(metric.campaign_id) = lower(attribution.utm_campaign)
          or lower(metric.campaign_name) = lower(attribution.utm_campaign)
        )
      order by metric.metric_date desc
      limit 1
    ) by_campaign on true
    where attribution.tenant_id = p_tenant_id
      and (attribution.provider = 'meta' or attribution.provider is null)
  )
  update public.player_attributions attribution
  set match_status = matches.match_status,
      match_confidence = matches.confidence,
      matched_ad_account_id = matches.ad_account_id,
      matched_campaign_id = matches.campaign_id,
      matched_adset_id = matches.adset_id,
      matched_ad_id = matches.ad_id,
      updated_at = now()
  from matches
  where attribution.id = matches.id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.reconcile_meta_attributions(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_meta_attributions(uuid) to service_role;

comment on function public.reconcile_meta_attributions(uuid) is
  'Reconciles tenant-scoped player attribution with the latest normalized Meta ad catalog.';

notify pgrst, 'reload schema';
