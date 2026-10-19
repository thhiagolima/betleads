-- Aquisição e LTV, fase AL1 (docs/ESCOPO_AQUISICAO_LTV_2026-10-18.md):
--   AL1-01 marketing_overview: todos os números da tela em uma RPC, sobre todas as linhas.
--   AL1-03 moeda gravada por linha de métrica; gasto fora de BRL nunca entra somado como BRL.
--   AL1-05 reconciliação única, por ID antes de nome, com status explícito.
--   AL1-07 cliques no link (inline_link_clicks).
--   AL1-08 catálogo de anúncios separado dos fatos (meta_ads).
--   AL1-09 a janela importada substitui a anterior; chave única sem NULL distinto.
--
-- Convenções:
--   * Cadastros, depósitos e saques são recortados no dia de Brasília. O gasto usa
--     metric_date, que a Meta já entrega no fuso da conta.
--   * A coorte do período são os jogadores cadastrados nele. A receita conta os
--     depósitos aprovados desses jogadores dentro do período; o líquido desconta os
--     saques aprovados no mesmo recorte (decisão D2).
--   * FTD é o primeiro depósito aprovado do jogador, com a mesma regra da Central
--     (players.ftd_em ausente ou até 10 minutos antes dele).
--   * "Pago" é o jogador reconciliado com anúncio ou campanha (matched_*). CAC e custo
--     por FTD só dividem o gasto por esses jogadores.
--
-- Compatível com o código já publicado: o upsert antigo continua achando a chave
-- única, reconcile_meta_attributions(p_tenant_id) continua chamável e os status
-- antigos continuam válidos.

-- 1. Métricas: moeda, cliques no link e chave única que trata NULL como igual.
alter table public.marketing_ad_metrics_daily
  add column if not exists currency text,
  add column if not exists link_clicks bigint not null default 0;

update public.marketing_ad_metrics_daily metric
set currency = upper(account.currency)
from public.meta_ad_accounts account
where metric.currency is null
  and account.tenant_id = metric.tenant_id
  and account.meta_ad_account_id = metric.ad_account_id
  and account.currency is not null;

alter table public.marketing_ad_metrics_daily
  drop constraint if exists marketing_ad_metrics_daily_tenant_id_provider_metric_date_a_key;
alter table public.marketing_ad_metrics_daily
  drop constraint if exists marketing_ad_metrics_daily_unique_day;
alter table public.marketing_ad_metrics_daily
  add constraint marketing_ad_metrics_daily_unique_day
  unique nulls not distinct (tenant_id, provider, metric_date, ad_account_id, ad_id);

-- Escrita só pelo servidor (service_role). Um membro da casa não grava gasto.
revoke insert, update, delete on public.marketing_ad_metrics_daily from authenticated;

-- 2. Catálogo de anúncios: nome, campanha, conjunto e miniatura, sem fingir um dia de gasto.
create table if not exists public.meta_ads (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ad_account_id text not null,
  ad_id text not null,
  ad_name text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  status text,
  effective_status text,
  creative_id text,
  thumbnail_url text,
  image_url text,
  raw jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, ad_account_id, ad_id)
);

create index if not exists meta_ads_tenant_ad_idx on public.meta_ads (tenant_id, lower(ad_id));
create index if not exists meta_ads_tenant_name_idx on public.meta_ads (tenant_id, lower(ad_name));
create index if not exists meta_ads_tenant_campaign_idx on public.meta_ads (tenant_id, lower(campaign_id));

alter table public.meta_ads enable row level security;
drop policy if exists meta_ads_tenant_read on public.meta_ads;
create policy meta_ads_tenant_read on public.meta_ads
  for select using (public.has_tenant_access(tenant_id));
grant select on public.meta_ads to authenticated;
grant all on public.meta_ads to service_role;

-- 3. Status de atribuição explícitos. "pending" = ainda não reconciliado.
alter table public.player_attributions
  drop constraint if exists player_attributions_match_status_check;
alter table public.player_attributions
  add constraint player_attributions_match_status_check check (
    match_status in (
      'matched_ad_id',
      'matched_ad_name',
      'matched_campaign_id',
      'matched_campaign_name',
      'ambiguous',
      'orphan_campaign',
      'missing_utm',
      'crm',
      'pending',
      'unmatched'
    )
  );
alter table public.player_attributions alter column match_status set default 'pending';

create index if not exists player_attributions_pending_idx
  on public.player_attributions (tenant_id)
  where match_status in ('pending', 'unmatched');

-- 4. Reconciliação. Ordem: ID do anúncio (utm_id ou utm_content) > nome único do
--    anúncio > ID da campanha > nome único da campanha. Nome repetido = ambiguous.
--    Clique do próprio CRM (utm_source=betleads ou token de clique) = crm, nunca mídia paga.
drop function if exists public.reconcile_meta_attributions(uuid);

create or replace function public.reconcile_meta_attributions(
  p_tenant_id uuid,
  p_only_pending boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  with catalog as (
    select ad_account_id, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name
    from public.meta_ads
    where tenant_id = p_tenant_id
    union
    select ad_account_id, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name
    from public.marketing_ad_metrics_daily
    where tenant_id = p_tenant_id and provider = 'meta' and ad_id is not null
  ),
  src as (
    select
      pa.id,
      nullif(trim(pa.utm_id), '') utm_id,
      nullif(trim(pa.utm_content), '') utm_content,
      nullif(trim(pa.utm_campaign), '') utm_campaign,
      nullif(trim(pa.utm_term), '') utm_term,
      nullif(trim(pa.utm_source), '') utm_source,
      pa.bl_click_id
    from public.player_attributions pa
    where pa.tenant_id = p_tenant_id
      and (not p_only_pending or pa.match_status in ('pending', 'unmatched'))
  ),
  resolved as (
    select
      s.id,
      s.utm_term,
      case
        when lower(coalesce(s.utm_source, '')) = 'betleads' or s.bl_click_id is not null then 'crm'
        when coalesce(s.utm_id, s.utm_content, s.utm_campaign, s.utm_source) is null then 'missing_utm'
        when by_ad.ad_id is not null then 'matched_ad_id'
        when by_name.n = 1 or by_name_in_campaign.n = 1 then 'matched_ad_name'
        when by_campaign_id.campaign_id is not null then 'matched_campaign_id'
        when by_name.n > 1 then 'ambiguous'
        when by_campaign_name.n = 1 then 'matched_campaign_name'
        when by_campaign_name.n > 1 then 'ambiguous'
        else 'orphan_campaign'
      end as match_status,
      coalesce(
        by_ad.ad_id,
        case when by_name.n = 1 then by_name.ad_id end,
        case when by_name.n > 1 and by_name_in_campaign.n = 1 then by_name_in_campaign.ad_id end
      ) as ad_id,
      coalesce(by_campaign_id.campaign_id, case when by_campaign_name.n = 1 then by_campaign_name.campaign_id end)
        as campaign_id_only,
      coalesce(by_campaign_id.ad_account_id, case when by_campaign_name.n = 1 then by_campaign_name.ad_account_id end)
        as campaign_account_only
    from src s
    left join lateral (
      select c.ad_id
      from catalog c
      where lower(c.ad_id) = lower(s.utm_id) or lower(c.ad_id) = lower(s.utm_content)
      order by (lower(c.ad_id) = lower(s.utm_id)) desc nulls last
      limit 1
    ) by_ad on true
    left join lateral (
      select count(distinct c.ad_id) n, min(c.ad_id) ad_id
      from catalog c
      where by_ad.ad_id is null and s.utm_content is not null
        and lower(c.ad_name) = lower(s.utm_content)
    ) by_name on true
    left join lateral (
      select count(distinct c.ad_id) n, min(c.ad_id) ad_id
      from catalog c
      where by_name.n > 1 and s.utm_campaign is not null
        and lower(c.ad_name) = lower(s.utm_content)
        and (lower(c.campaign_id) = lower(s.utm_campaign) or lower(c.campaign_name) = lower(s.utm_campaign))
    ) by_name_in_campaign on true
    left join lateral (
      select c.campaign_id, c.ad_account_id
      from catalog c
      where s.utm_campaign is not null and lower(c.campaign_id) = lower(s.utm_campaign)
      limit 1
    ) by_campaign_id on true
    left join lateral (
      select count(distinct c.campaign_id) n, min(c.campaign_id) campaign_id, min(c.ad_account_id) ad_account_id
      from catalog c
      where s.utm_campaign is not null and lower(c.campaign_name) = lower(s.utm_campaign)
    ) by_campaign_name on true
  ),
  matches as (
    select
      r.id,
      r.match_status,
      case r.match_status
        when 'matched_ad_id' then 100
        when 'matched_ad_name' then 85
        when 'matched_campaign_id' then 75
        when 'matched_campaign_name' then 65
        else 0
      end as confidence,
      case when r.match_status like 'matched\_%' then coalesce(ad.ad_account_id, r.campaign_account_only) end
        as ad_account_id,
      case when r.match_status like 'matched\_%' then coalesce(ad.campaign_id, r.campaign_id_only) end
        as campaign_id,
      case when r.match_status like 'matched\_%' then coalesce(ad.adset_id, adset.adset_id) end
        as adset_id,
      case when r.match_status in ('matched_ad_id', 'matched_ad_name') then r.ad_id end as ad_id
    from resolved r
    left join lateral (
      select c.ad_account_id, c.campaign_id, c.adset_id
      from catalog c
      where r.ad_id is not null and c.ad_id = r.ad_id
      limit 1
    ) ad on true
    left join lateral (
      select c.adset_id
      from catalog c
      where r.ad_id is null and r.campaign_id_only is not null and r.utm_term is not null
        and c.campaign_id = r.campaign_id_only
        and (lower(c.adset_id) = lower(r.utm_term) or lower(c.adset_name) = lower(r.utm_term))
      limit 1
    ) adset on true
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

comment on function public.reconcile_meta_attributions(uuid, boolean) is
  'Tenant-scoped attribution reconciliation: ad ID > unique ad name > campaign ID > unique campaign name.';

revoke all on function public.reconcile_meta_attributions(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reconcile_meta_attributions(uuid, boolean) to service_role;

-- Cadastros novos chegam o dia inteiro; o worker reconcilia só os pendentes de cada casa.
create or replace function public.reconcile_pending_meta_attributions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  tenant uuid;
  total integer := 0;
begin
  for tenant in
    select distinct tenant_id from public.player_attributions
    where match_status in ('pending', 'unmatched')
  loop
    total := total + public.reconcile_meta_attributions(tenant, true);
  end loop;
  return total;
end;
$$;

revoke all on function public.reconcile_pending_meta_attributions() from public, anon, authenticated;
grant execute on function public.reconcile_pending_meta_attributions() to service_role;

-- 5. Substitui a janela importada de uma conta: o que a Meta não devolve mais sai.
create or replace function public.replace_meta_ad_metrics(
  p_tenant_id uuid,
  p_ad_account_id text,
  p_since date,
  p_until date,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer := 0;
begin
  delete from public.marketing_ad_metrics_daily
  where tenant_id = p_tenant_id
    and provider = 'meta'
    and ad_account_id = p_ad_account_id
    and metric_date between p_since and p_until;

  insert into public.marketing_ad_metrics_daily (
    tenant_id, provider, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
    ad_id, ad_name, creative_name, metric_date, spend, impressions, clicks, link_clicks,
    ctr, cpc, cpm, currency, raw, imported_at
  )
  select
    p_tenant_id, 'meta', p_ad_account_id, r.campaign_id, r.campaign_name, r.adset_id, r.adset_name,
    r.ad_id, r.ad_name, coalesce(r.creative_name, r.ad_name), r.metric_date,
    coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.clicks, 0), coalesce(r.link_clicks, 0),
    r.ctr, r.cpc, r.cpm, upper(r.currency), coalesce(r.raw, '{}'::jsonb), now()
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    campaign_id text, campaign_name text, adset_id text, adset_name text, ad_id text,
    ad_name text, creative_name text, metric_date date, spend numeric, impressions bigint,
    clicks bigint, link_clicks bigint, ctr numeric, cpc numeric, cpm numeric, currency text,
    raw jsonb
  )
  where r.metric_date between p_since and p_until
  on conflict (tenant_id, provider, metric_date, ad_account_id, ad_id) do update
  set campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      adset_id = excluded.adset_id,
      adset_name = excluded.adset_name,
      ad_name = excluded.ad_name,
      creative_name = excluded.creative_name,
      spend = excluded.spend,
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      link_clicks = excluded.link_clicks,
      ctr = excluded.ctr,
      cpc = excluded.cpc,
      cpm = excluded.cpm,
      currency = excluded.currency,
      raw = excluded.raw,
      imported_at = excluded.imported_at,
      updated_at = now();

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.replace_meta_ad_metrics(uuid, text, date, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_meta_ad_metrics(uuid, text, date, date, jsonb) to service_role;

-- 6. Overview da tela. Totais sobre todas as linhas; listas com as 50 primeiras e "outros".
create or replace function public.marketing_overview(_tenant uuid, _from date, _to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  result jsonb;
begin
  if not (public.has_tenant_access(_tenant) or auth.role() = 'service_role') then
    raise exception 'Sem acesso a esta casa.' using errcode = '42501';
  end if;
  if _from is null or _to is null or _from > _to then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if _to - _from > 366 then
    raise exception 'O período máximo é de 1 ano.' using errcode = '22023';
  end if;

  v_from := (_from::timestamp at time zone 'America/Sao_Paulo');
  v_to := ((_to + 1)::timestamp at time zone 'America/Sao_Paulo');

  with
  acct as (
    select meta_ad_account_id, upper(currency) currency
    from public.meta_ad_accounts where tenant_id = _tenant
  ),
  m as (
    select
      coalesce(nullif(x.ad_id, ''), 'nome:' || coalesce(x.ad_name, x.creative_name, '?')) ad_key,
      nullif(x.ad_id, '') ad_id,
      coalesce(x.creative_name, x.ad_name) ad_name,
      x.campaign_id, x.campaign_name, x.adset_id, x.adset_name, x.metric_date,
      x.spend, x.impressions, x.clicks, x.link_clicks,
      coalesce(upper(x.currency), a.currency, 'BRL') currency
    from public.marketing_ad_metrics_daily x
    left join acct a on a.meta_ad_account_id = x.ad_account_id
    where x.tenant_id = _tenant and x.metric_date between _from and _to
  ),
  mb as (
    select m.*,
           case when currency = 'BRL' then spend else 0 end spend_brl,
           case when currency <> 'BRL' then spend else 0 end spend_other
    from m
  ),
  signups as (
    select
      p.id, p.created_at, p.ftd_em,
      pa.match_status, pa.matched_ad_id, pa.matched_campaign_id, pa.matched_adset_id, pa.provider,
      nullif(trim(coalesce(pa.utm_source, p.utm_source)), '') utm_source,
      nullif(trim(coalesce(pa.utm_campaign, p.utm_campaign)), '') utm_campaign,
      nullif(trim(coalesce(pa.utm_content, pa.utm_id, p.utm_content, p.utm_id)), '') utm_content,
      nullif(trim(coalesce(pa.utm_term, p.utm_term)), '') utm_term
    from public.players p
    left join public.player_attributions pa
      on pa.tenant_id = p.tenant_id and pa.player_id = p.id and pa.event_type = 'signup'
    where p.tenant_id = _tenant and p.created_at >= v_from and p.created_at < v_to
  ),
  s2 as (
    select s.*,
      case
        when s.match_status is not null and s.match_status not in ('pending', 'unmatched') then s.match_status
        when lower(coalesce(s.utm_source, '')) = 'betleads' then 'crm'
        when coalesce(s.utm_source, s.utm_campaign, s.utm_content) is null then 'missing_utm'
        when s.match_status is null then 'orphan_campaign'
        else 'pending'
      end status
    from signups s
  ),
  pl as (
    select s2.*,
      s2.status like 'matched\_%' paid,
      coalesce(d.gross, 0) gross,
      coalesce(d.ftd_value, 0) ftd_value,
      coalesce(d.is_ftd, false) is_ftd,
      d.ftd_at,
      coalesce(w.withdrawn, 0) withdrawn
    from s2
    left join lateral (
      select sum(x.valor) gross,
             sum(x.valor) filter (where x.first_real) ftd_value,
             bool_or(x.first_real) is_ftd,
             min(x.created_at) filter (where x.first_real) ftd_at
      from (
        select dd.valor, dd.created_at,
               row_number() over (order by dd.created_at, dd.id) = 1
                 and (s2.ftd_em is null or s2.ftd_em >= dd.created_at - interval '10 minutes') first_real
        from public.deposits dd
        where dd.tenant_id = _tenant and dd.player_id = s2.id
          and dd.status = 'aprovado' and dd.created_at < v_to
      ) x
      where x.created_at >= v_from
    ) d on true
    left join lateral (
      select sum(ww.valor) withdrawn
      from public.withdrawals ww
      where ww.tenant_id = _tenant and ww.player_id = s2.id and ww.status = 'aprovado'
        and ww.created_at >= v_from and ww.created_at < v_to
    ) w on true
  ),
  paid as (select * from pl where paid),

  -- Anúncios
  m_ad as (
    select ad_key, max(ad_id) ad_id,
      (array_agg(ad_name order by metric_date desc))[1] ad_name,
      (array_agg(campaign_id order by metric_date desc))[1] campaign_id,
      (array_agg(campaign_name order by metric_date desc))[1] campaign_name,
      (array_agg(adset_name order by metric_date desc))[1] adset_name,
      sum(spend_brl) spend, sum(spend_other) spend_other,
      sum(impressions) impressions, sum(clicks) clicks, sum(link_clicks) link_clicks
    from mb group by ad_key
  ),
  p_ad as (
    select matched_ad_id ad_id, count(*) players, count(*) filter (where is_ftd) ftd,
           sum(gross) gross, sum(ftd_value) ftd_value, sum(withdrawn) withdrawn
    from paid where matched_ad_id is not null group by matched_ad_id
  ),
  ad_rows as (
    select
      coalesce(m.ad_id, p.ad_id) ad_id,
      coalesce(m.ad_name, cat.ad_name, coalesce(m.ad_id, p.ad_id)) creative,
      coalesce(m.campaign_name, cat.campaign_name) campaign,
      coalesce(m.campaign_id, cat.campaign_id) campaign_id,
      coalesce(m.adset_name, cat.adset_name) adset,
      coalesce(cat.thumbnail_url, cat.image_url) thumbnail_url,
      coalesce(m.spend, 0) spend, coalesce(m.spend_other, 0) spend_other,
      coalesce(m.impressions, 0) impressions, coalesce(m.clicks, 0) clicks,
      coalesce(m.link_clicks, 0) link_clicks,
      coalesce(p.players, 0) players, coalesce(p.ftd, 0) ftd,
      coalesce(p.gross, 0) revenue, coalesce(p.gross, 0) - coalesce(p.withdrawn, 0) net,
      coalesce(p.ftd_value, 0) ftd_revenue, coalesce(p.gross, 0) - coalesce(p.ftd_value, 0) redeposit_revenue
    from m_ad m
    full join p_ad p on p.ad_id = m.ad_id
    left join lateral (
      select c.ad_name, c.campaign_name, c.campaign_id, c.adset_name, c.thumbnail_url, c.image_url
      from public.meta_ads c
      where c.tenant_id = _tenant and c.ad_id = coalesce(m.ad_id, p.ad_id)
      limit 1
    ) cat on true
  ),
  ad_ranked as (
    select a.*, row_number() over (order by revenue desc, spend desc, players desc, creative) rn
    from ad_rows a
  ),

  -- Campanhas
  m_camp as (
    select coalesce(campaign_id, 'nome:' || coalesce(campaign_name, '?')) camp_key,
      max(campaign_id) campaign_id,
      (array_agg(campaign_name order by metric_date desc))[1] campaign_name,
      sum(spend_brl) spend, sum(spend_other) spend_other,
      sum(impressions) impressions, sum(clicks) clicks, sum(link_clicks) link_clicks
    from mb group by 1
  ),
  p_camp as (
    select matched_campaign_id campaign_id, count(*) players, count(*) filter (where is_ftd) ftd,
           sum(gross) gross, sum(ftd_value) ftd_value, sum(withdrawn) withdrawn
    from paid where matched_campaign_id is not null group by matched_campaign_id
  ),
  camp_rows as (
    select
      coalesce(m.campaign_name, cat.campaign_name, coalesce(m.campaign_id, p.campaign_id)) campaign,
      coalesce(m.campaign_id, p.campaign_id) campaign_id,
      coalesce(m.spend, 0) spend, coalesce(m.spend_other, 0) spend_other,
      coalesce(m.impressions, 0) impressions, coalesce(m.clicks, 0) clicks,
      coalesce(m.link_clicks, 0) link_clicks,
      coalesce(p.players, 0) players, coalesce(p.ftd, 0) ftd,
      coalesce(p.gross, 0) revenue, coalesce(p.gross, 0) - coalesce(p.withdrawn, 0) net,
      coalesce(p.ftd_value, 0) ftd_revenue, coalesce(p.gross, 0) - coalesce(p.ftd_value, 0) redeposit_revenue
    from m_camp m
    full join p_camp p on p.campaign_id = m.campaign_id
    left join lateral (
      select c.campaign_name from public.meta_ads c
      where c.tenant_id = _tenant and c.campaign_id = coalesce(m.campaign_id, p.campaign_id)
      limit 1
    ) cat on true
  ),
  camp_ranked as (
    select c.*, row_number() over (order by revenue desc, spend desc, players desc, campaign) rn
    from camp_rows c
  ),

  -- Conjuntos (públicos)
  m_set as (
    select coalesce(adset_id, 'nome:' || coalesce(adset_name, '?')) set_key,
      max(adset_id) adset_id,
      (array_agg(adset_name order by metric_date desc))[1] adset_name,
      sum(spend_brl) spend, count(distinct ad_key) ads,
      sum(impressions) impressions, sum(clicks) clicks
    from mb group by 1
  ),
  p_set as (
    select matched_adset_id adset_id, count(*) players, count(*) filter (where is_ftd) ftd,
           sum(gross) gross, sum(withdrawn) withdrawn
    from paid where matched_adset_id is not null group by matched_adset_id
  ),
  set_rows as (
    select
      coalesce(m.adset_name, cat.adset_name, coalesce(m.adset_id, p.adset_id)) adset,
      coalesce(m.spend, 0) spend, coalesce(m.ads, 0) ads,
      coalesce(m.impressions, 0) impressions, coalesce(m.clicks, 0) clicks,
      coalesce(p.players, 0) players, coalesce(p.ftd, 0) ftd,
      coalesce(p.gross, 0) revenue, coalesce(p.gross, 0) - coalesce(p.withdrawn, 0) net
    from m_set m
    full join p_set p on p.adset_id = m.adset_id
    left join lateral (
      select c.adset_name from public.meta_ads c
      where c.tenant_id = _tenant and c.adset_id = coalesce(m.adset_id, p.adset_id)
      limit 1
    ) cat on true
  ),
  set_ranked as (
    select s.*, row_number() over (order by spend desc, ftd desc, players desc, adset) rn
    from set_rows s
  ),

  -- Origens marcadas sem anúncio correspondente
  orphan_rows as (
    select coalesce(utm_campaign, '(sem campanha)') campaign,
           coalesce(utm_content, '(sem criativo)') creative,
           max(utm_term) adset, max(utm_source) source, max(provider) provider,
           bool_or(status = 'ambiguous') ambiguous,
           count(*) players, count(*) filter (where is_ftd) ftd, sum(gross) revenue
    from pl where status in ('orphan_campaign', 'ambiguous', 'pending')
    group by 1, 2
  ),

  daily as (
    select d::date date,
      coalesce((select sum(spend_brl) from mb where mb.metric_date = d::date), 0) spend,
      (select count(*) from paid
        where paid.is_ftd and (paid.ftd_at at time zone 'America/Sao_Paulo')::date = d::date) ftd,
      (select count(*) from paid
        where (paid.created_at at time zone 'America/Sao_Paulo')::date = d::date) signups
    from generate_series(_from::timestamp, _to::timestamp, interval '1 day') d
  ),

  totals as (
    select
      (select coalesce(sum(spend_brl), 0) from mb) spend,
      (select coalesce(sum(impressions), 0) from mb) impressions,
      (select coalesce(sum(clicks), 0) from mb) clicks,
      (select coalesce(sum(link_clicks), 0) from mb) link_clicks,
      (select count(*) from pl) players,
      (select count(*) from pl where is_ftd) ftd_all,
      (select count(*) from paid) paid_players,
      (select count(*) from paid where is_ftd) paid_ftd,
      (select coalesce(sum(gross), 0) from paid) revenue,
      (select coalesce(sum(withdrawn), 0) from paid) withdrawn,
      (select coalesce(sum(ftd_value), 0) from paid) ftd_revenue,
      (select count(*) from pl where status not in ('missing_utm')) marked,
      (select count(*) from pl where status = 'missing_utm') missing_utm,
      (select count(*) from pl where status = 'crm') crm,
      (select count(*) from pl where status = 'ambiguous') ambiguous,
      (select count(*) from pl where status = 'orphan_campaign') orphan,
      (select count(*) from pl where status = 'pending') pending
  )

  select jsonb_build_object(
    'period', jsonb_build_object('from', _from, 'to', _to),
    'totals', (
      select jsonb_build_object(
        'spend', t.spend,
        'spendOther', coalesce((
          select jsonb_agg(jsonb_build_object('currency', currency, 'spend', total) order by currency)
          from (select currency, sum(spend) total from mb where currency <> 'BRL' group by currency) o
        ), '[]'::jsonb),
        'impressions', t.impressions,
        'clicks', t.clicks,
        'linkClicks', t.link_clicks,
        'players', t.players,
        'ftd', t.ftd_all,
        'paidPlayers', t.paid_players,
        'paidFtd', t.paid_ftd,
        'markedPlayers', t.marked,
        'orphanPlayers', t.orphan + t.ambiguous + t.pending,
        'revenue', t.revenue,
        'withdrawals', t.withdrawn,
        'net', t.revenue - t.withdrawn,
        'ftdRevenue', t.ftd_revenue,
        'redepositRevenue', t.revenue - t.ftd_revenue,
        'roas', case when t.spend > 0 then round((t.revenue - t.withdrawn) / t.spend, 4) end,
        'roasGross', case when t.spend > 0 then round(t.revenue / t.spend, 4) end,
        'cpaFtd', case when t.spend > 0 and t.paid_ftd > 0 then round(t.spend / t.paid_ftd, 2) end,
        'cacSignup', case when t.spend > 0 and t.paid_players > 0 then round(t.spend / t.paid_players, 2) end
      ) from totals t
    ),
    'attributionHealth', (
      select jsonb_build_object(
        'total', t.players,
        'marked', t.marked,
        'matched', t.paid_players,
        'missingUtm', t.missing_utm,
        'crm', t.crm,
        'ambiguous', t.ambiguous,
        'orphan', t.orphan,
        'pending', t.pending,
        'matchRate', case when t.marked - t.crm > 0
          then round(100.0 * t.paid_players / (t.marked - t.crm), 2) end
      ) from totals t
    ),
    'creatives', coalesce((
      select jsonb_agg(jsonb_build_object(
        'creative', creative, 'campaign', campaign, 'campaign_id', campaign_id, 'adset', adset,
        'ad_id', ad_id, 'thumbnail_url', thumbnail_url, 'spend', spend, 'spendOther', spend_other,
        'impressions', impressions, 'clicks', clicks, 'linkClicks', link_clicks,
        'players', players, 'ftd', ftd, 'revenue', revenue, 'net', net,
        'ftdRevenue', ftd_revenue, 'redepositRevenue', redeposit_revenue
      ) order by rn)
      from ad_ranked where rn <= 50
    ), '[]'::jsonb),
    'creativesOthers', (
      select jsonb_build_object(
        'count', count(*), 'spend', coalesce(sum(spend), 0), 'impressions', coalesce(sum(impressions), 0),
        'clicks', coalesce(sum(clicks), 0), 'linkClicks', coalesce(sum(link_clicks), 0),
        'players', coalesce(sum(players), 0), 'ftd', coalesce(sum(ftd), 0),
        'revenue', coalesce(sum(revenue), 0), 'net', coalesce(sum(net), 0)
      ) from ad_ranked where rn > 50
    ),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign', campaign, 'campaign_id', campaign_id,
        'match_status', case when spend > 0 or impressions > 0 then 'matched_campaign' else 'no_spend' end,
        'spend', spend, 'spendOther', spend_other, 'impressions', impressions, 'clicks', clicks,
        'linkClicks', link_clicks, 'players', players, 'ftd', ftd, 'revenue', revenue, 'net', net,
        'ftdRevenue', ftd_revenue, 'redepositRevenue', redeposit_revenue
      ) order by rn)
      from camp_ranked where rn <= 50
    ), '[]'::jsonb),
    'campaignsOthers', (
      select jsonb_build_object(
        'count', count(*), 'spend', coalesce(sum(spend), 0), 'players', coalesce(sum(players), 0),
        'ftd', coalesce(sum(ftd), 0), 'revenue', coalesce(sum(revenue), 0), 'net', coalesce(sum(net), 0)
      ) from camp_ranked where rn > 50
    ),
    'audiences', coalesce((
      select jsonb_agg(jsonb_build_object(
        'adset', adset, 'spend', spend, 'ads', ads, 'impressions', impressions, 'clicks', clicks,
        'players', players, 'ftd', ftd, 'revenue', revenue, 'net', net
      ) order by rn)
      from set_ranked where rn <= 50
    ), '[]'::jsonb),
    'audiencesOthers', (
      select jsonb_build_object(
        'count', count(*), 'spend', coalesce(sum(spend), 0), 'players', coalesce(sum(players), 0),
        'ftd', coalesce(sum(ftd), 0), 'revenue', coalesce(sum(revenue), 0)
      ) from set_ranked where rn > 50
    ),
    'orphanAttributions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign', campaign, 'creative', creative, 'adset', adset, 'source', source,
        'provider', provider, 'ambiguous', ambiguous, 'players', players, 'ftd', ftd,
        'revenue', revenue
      ) order by revenue desc, players desc)
      from (select * from orphan_rows order by revenue desc, players desc limit 50) o
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', date, 'label', to_char(date, 'DD/MM'), 'spend', spend, 'ftd', ftd, 'signups', signups
      ) order by date)
      from daily
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.marketing_overview(uuid, date, date) from public, anon;
grant execute on function public.marketing_overview(uuid, date, date) to authenticated, service_role;

-- 7. Jogadores com UTM e sem linha de atribuição (importados direto em players, como
--    na exportação da Sorte Alta) ganham a linha de cadastro, para a reconciliação
--    alcançá-los. A origem fica marcada em raw_payload.
insert into public.player_attributions (
  tenant_id, player_id, event_type, provider, utm_source, utm_medium, utm_campaign,
  utm_content, utm_term, utm_id, raw_payload, match_status, captured_at
)
select
  p.tenant_id, p.id, 'signup',
  case when lower(trim(p.utm_source)) in ('fb', 'facebook', 'ig', 'instagram', 'meta', 'an', 'msg')
    then 'meta' end,
  nullif(trim(p.utm_source), ''), nullif(trim(p.utm_medium), ''), nullif(trim(p.utm_campaign), ''),
  nullif(trim(p.utm_content), ''), nullif(trim(p.utm_term), ''), nullif(trim(p.utm_id), ''),
  jsonb_build_object('source', 'players_backfill_20261019'),
  'pending',
  p.created_at
from public.players p
where coalesce(nullif(trim(p.utm_source), ''), nullif(trim(p.utm_campaign), ''),
               nullif(trim(p.utm_content), ''), nullif(trim(p.utm_id), '')) is not null
  and not exists (
    select 1 from public.player_attributions pa
    where pa.tenant_id = p.tenant_id and pa.player_id = p.id and pa.event_type = 'signup'
  )
on conflict (tenant_id, player_id, event_type) do nothing;

-- Primeira reconciliação no novo critério.
do $$
declare
  tenant uuid;
begin
  for tenant in select distinct tenant_id from public.player_attributions loop
    perform public.reconcile_meta_attributions(tenant, false);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
