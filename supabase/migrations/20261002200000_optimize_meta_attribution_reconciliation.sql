-- A conciliaÃ§Ã£o Ã© executada apÃ³s uma sincronizaÃ§Ã£o Meta. Estes Ã­ndices evitam
-- varrer todo o catÃ¡logo de anÃºncios para cada jogador marcado.
create index if not exists marketing_meta_lookup_ad_id_idx
  on public.marketing_ad_metrics_daily (tenant_id, lower(ad_id), metric_date desc)
  where provider = 'meta' and ad_id is not null;

create index if not exists marketing_meta_lookup_ad_name_idx
  on public.marketing_ad_metrics_daily (tenant_id, lower(ad_name), metric_date desc)
  where provider = 'meta' and ad_name is not null;

create index if not exists marketing_meta_lookup_campaign_id_idx
  on public.marketing_ad_metrics_daily (tenant_id, lower(campaign_id), metric_date desc)
  where provider = 'meta' and campaign_id is not null;

create index if not exists marketing_meta_lookup_campaign_name_idx
  on public.marketing_ad_metrics_daily (tenant_id, lower(campaign_name), metric_date desc)
  where provider = 'meta' and campaign_name is not null;

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
  where attribution.id = matches.id
    and (
      attribution.match_status is distinct from matches.match_status
      or attribution.match_confidence is distinct from matches.confidence
      or attribution.matched_ad_account_id is distinct from matches.ad_account_id
      or attribution.matched_campaign_id is distinct from matches.campaign_id
      or attribution.matched_adset_id is distinct from matches.adset_id
      or attribution.matched_ad_id is distinct from matches.ad_id
    );

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.reconcile_meta_attributions(uuid) is
  'Tenant-scoped Meta attribution reconciliation, indexed and write-minimizing.';

notify pgrst, 'reload schema';
