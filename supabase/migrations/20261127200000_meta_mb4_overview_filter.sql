-- MB4-04: filtro por BM / conta de anúncio no overview de Mídia e LTV.
-- marketing_overview ganha _ad_account_ids text[] (opcional). Sem filtro (nulo ou vazio)
-- o resultado é idêntico ao da versão de 3 argumentos. Com filtro:
--   * gasto e métricas só das linhas com ad_account_id na lista;
--   * jogadores (cadastros, FTD, depósitos, saques, LTV e todas as tabelas por
--     anúncio/campanha/conjunto) só os com player_attributions.matched_ad_account_id
--     na lista; tráfego sem atribuição, só UTM, orgânico e CRM fica de fora;
--   * o JSON ganha "filter": {"ad_account_ids": [...], "players_scope": "matched_only"}.
-- Chamadas com os 3 argumentos nomeados continuam funcionando (default null).

drop function if exists public.marketing_overview(uuid, date, date);
drop function if exists public.marketing_overview(uuid, date, date, text[]);

-- Overview da tela. Totais sobre todas as linhas; listas com as 50 primeiras e "outros".
create or replace function public.marketing_overview(
  _tenant uuid,
  _from date,
  _to date,
  _ad_account_ids text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_ids text[];
  v_filtered boolean;
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

  -- Filtro por conta de anúncio (act_…): nulo, vazio ou só nulos = sem filtro.
  v_ids := array(
    select distinct trim(i) from unnest(coalesce(_ad_account_ids, '{}'::text[])) i
    where nullif(trim(i), '') is not null
    order by 1
  );
  v_filtered := cardinality(v_ids) > 0;

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
      -- Com filtro, só o gasto das contas escolhidas.
      and (not v_filtered or x.ad_account_id = any(v_ids))
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
      -- Com filtro, só jogadores atribuídos a essas contas. Sem atribuição, só UTM,
      -- orgânico e CRM ficam de fora (matched_ad_account_id nulo).
      and (not v_filtered or pa.matched_ad_account_id = any(v_ids))
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
  -- A chave "filter" só aparece com filtro; sem ele, o JSON é igual ao de antes.
  || case when v_filtered then jsonb_build_object('filter', jsonb_build_object(
       'ad_account_ids', to_jsonb(v_ids), 'players_scope', 'matched_only'))
     else '{}'::jsonb end
  into result;

  return result;
end;
$$;

revoke all on function public.marketing_overview(uuid, date, date, text[]) from public, anon;
grant execute on function public.marketing_overview(uuid, date, date, text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
