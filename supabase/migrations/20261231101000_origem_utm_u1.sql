-- U1 de ESCOPO_ORIGEM_UTM_2026-11-14: aba Origem em Aquisição e LTV.
--   attribution_channel: regra única que junta fonte/meio sujos (ig, fb, instagram, an…)
--     num canal legível. Não depende de Meta conectada.
--   origin_breakdown: cadastros do período agrupados por canal, fonte, meio, campanha,
--     conjunto (utm_term) ou anúncio (utm_content), com 1º depósito e depósito líquido
--     de cada coorte desde o cadastro até hoje. CRM próprio (bl_click_id ou
--     utm_source=betleads) fica fora da conta; "sem origem" volta à parte.
--   Cadastro sem UTM mas com afiliado/indicação (players.affiliate_id) vira o canal
--     "afiliados": é a origem da maior parte dos cadastros sem UTM (betgreen, pixreals,
--     mega-sorte-7k, 99bet), que vêm por link de afiliado ou ?ref=.
-- Não usa nada da F1 (20261231100900); pode ser aplicada antes ou depois dela.

create or replace function public.attribution_channel(
  _source text,
  _medium text,
  _has_other_utm boolean default false,
  _has_fbclid boolean default false,
  _has_gclid boolean default false,
  _has_ttclid boolean default false
)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    -- Sem fonte nem meio: só o click ID diz alguma coisa.
    when x.s is null and x.m is null then
      case
        when coalesce(_has_gclid, false) then 'google'
        when coalesce(_has_ttclid, false) then 'tiktok'
        when coalesce(_has_fbclid, false) then
          case when coalesce(_has_other_utm, false) then 'meta' else 'meta_sem_campanha' end
        when coalesce(_has_other_utm, false) then 'outros'
        else 'sem_origem'
      end
    when x.s = 'betleads' then 'crm'
    when x.m like 'live%' or x.s like 'live%' then 'live'
    when x.m in ('influencer', 'influenciador', 'influencers') then 'influencer'
    when x.m in ('affiliate', 'afiliado', 'afiliados') or x.s like '%afiliad%' then 'afiliados'
    when x.s in ('fb', 'facebook', 'ig', 'instagram', 'meta', 'an', 'msg', 'th', 'threads',
                 'facebook_ads', 'instagram_ads', 'fb_ads', 'ig_ads', 'meta_ads')
      or x.s like '%facebook%' or x.s like '%instagram%' then 'meta'
    when x.s like '%google%' or x.s in ('gads', 'adwords', 'youtube', 'yt')
      or coalesce(_has_gclid, false) then 'google'
    when x.s like '%tiktok%' or x.s = 'tt' then 'tiktok'
    when x.s like '%kwai%' then 'kwai'
    when x.s in ('wa', 'whatsapp', 'zap') or x.s like '%whatsapp%' then 'whatsapp'
    when x.s like '%telegram%' or x.s = 'tg' then 'telegram'
    when x.m in ('sms', 'rcs', 'messaging', 'push', 'email', 'e-mail')
      or x.s in ('sms', 'rcs') then 'mensagens'
    when x.s ~ '(chatgpt|openai|perplexity|gemini|bing|yahoo|duckduckgo)' then 'busca'
    else 'outros'
  end
  from (select nullif(lower(trim(_source)), '') s, nullif(lower(trim(_medium)), '') m) x
$$;

revoke all on function public.attribution_channel(text, text, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.attribution_channel(text, text, boolean, boolean, boolean, boolean)
  to authenticated, service_role;

create or replace function public.origin_breakdown(
  _tenant uuid,
  _from date,
  _to date,
  _group text default 'channel',
  _filters jsonb default '{}'::jsonb,
  _include_crm boolean default false,
  _limit integer default 100
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
  v_f jsonb := coalesce(_filters, '{}'::jsonb);
  v_search text;
  v_only_ftd boolean;
  v_limit integer;
  result jsonb;
begin
  if not (public.has_tenant_access(_tenant) or auth.role() = 'service_role') then
    raise exception 'Sem acesso a esta casa.' using errcode = '42501';
  end if;
  if _from is null or _to is null or _from > _to then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if _to - _from > 92 then
    raise exception 'O período máximo é de 93 dias.' using errcode = '22023';
  end if;
  if _group is null or _group not in (
    'channel', 'source', 'medium', 'campaign', 'term', 'content', 'affiliate'
  ) then
    raise exception 'Agrupamento inválido.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'Filtro inválido.' using errcode = '22023';
  end if;

  v_from := (_from::timestamp at time zone 'America/Sao_Paulo');
  v_to := ((_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_search := nullif(lower(trim(v_f->>'search')), '');
  v_only_ftd := coalesce((v_f->>'onlyFtd')::boolean, false);
  v_limit := least(greatest(coalesce(_limit, 100), 1), 500);

  with
  base as (
    select
      p.id, p.created_at, p.ftd_em,
      nullif(trim(p.affiliate_id), '') aff,
      nullif(trim(p.expert), '') expert,
      nullif(trim(coalesce(pa.utm_source, p.utm_source)), '') src,
      nullif(trim(coalesce(pa.utm_medium, p.utm_medium)), '') med,
      nullif(trim(coalesce(pa.utm_campaign, p.utm_campaign)), '') camp,
      nullif(trim(coalesce(pa.utm_term, p.utm_term)), '') term,
      nullif(trim(coalesce(pa.utm_content, p.utm_content)), '') content,
      coalesce(nullif(trim(pa.fbclid), ''), '') <> '' has_fb,
      coalesce(nullif(trim(pa.gclid), ''), nullif(trim(pa.gbraid), ''), nullif(trim(pa.wbraid), ''), '') <> '' has_g,
      coalesce(nullif(trim(pa.ttclid), ''), '') <> '' has_tt,
      -- Link do próprio CRM: o bl_click_id é a chave confiável, porque o link do SMS pode
      -- levar a utm_source da casa (shortio.server.ts só põe "betleads" sem source).
      pa.bl_click_id is not null is_link_crm
    from public.players p
    left join public.player_attributions pa
      on pa.tenant_id = p.tenant_id and pa.player_id = p.id and pa.event_type = 'signup'
    where p.tenant_id = _tenant and p.created_at >= v_from and p.created_at < v_to
  ),
  c as (
    select b.*,
      case when b.is_link_crm then 'crm'
           when ch.v = 'sem_origem' and b.aff is not null then 'afiliados'
           else ch.v
      end channel
    from base b
    cross join lateral (
      select public.attribution_channel(
        b.src, b.med, coalesce(b.camp, b.term, b.content) is not null, b.has_fb, b.has_g, b.has_tt) v
    ) ch
  ),
  -- Filtros de dimensão antes das somas de depósito: o drill corta a coorte cedo.
  f as (
    select c.* from c
    where (_include_crm or c.channel <> 'crm')
      and (not (v_f ? 'channel') or c.channel is not distinct from (v_f->>'channel'))
      and (not (v_f ? 'source') or lower(c.src) is not distinct from lower(v_f->>'source'))
      and (not (v_f ? 'medium') or lower(c.med) is not distinct from lower(v_f->>'medium'))
      and (not (v_f ? 'campaign') or lower(c.camp) is not distinct from lower(v_f->>'campaign'))
      and (not (v_f ? 'term') or lower(c.term) is not distinct from lower(v_f->>'term'))
      and (not (v_f ? 'content') or lower(c.content) is not distinct from lower(v_f->>'content'))
      and (not (v_f ? 'affiliate') or lower(c.aff) is not distinct from lower(v_f->>'affiliate'))
      and (v_search is null
           or strpos(lower(concat_ws(' ', c.src, c.med, c.camp, c.term, c.content, c.aff, c.expert)),
                     v_search) > 0)
  ),
  -- Coorte até hoje: tudo o que o jogador depositou e sacou depois do cadastro.
  pl as (
    select f.*,
      coalesce(d.gross, 0) gross,
      coalesce(d.ftd_value, 0) ftd_value,
      coalesce(d.is_ftd, false) is_ftd,
      coalesce(w.withdrawn, 0) withdrawn
    from f
    left join lateral (
      select sum(x.valor) gross,
             sum(x.valor) filter (where x.first_real) ftd_value,
             bool_or(x.first_real) is_ftd
      from (
        select dd.valor,
               row_number() over (order by dd.created_at, dd.id) = 1
                 and (f.ftd_em is null or f.ftd_em >= dd.created_at - interval '10 minutes') first_real
        from public.deposits dd
        where dd.tenant_id = _tenant and dd.player_id = f.id and dd.status = 'aprovado'
      ) x
    ) d on true
    left join lateral (
      select sum(ww.valor) withdrawn
      from public.withdrawals ww
      where ww.tenant_id = _tenant and ww.player_id = f.id and ww.status = 'aprovado'
    ) w on true
  ),
  sel as (
    select * from pl where not v_only_ftd or is_ftd
  ),
  keyed as (
    select sel.*,
      case _group
        when 'channel' then channel
        when 'source' then lower(src)
        when 'medium' then lower(med)
        when 'campaign' then lower(camp)
        when 'term' then lower(term)
        when 'content' then lower(content)
        else lower(aff)
      end gkey,
      case _group
        when 'channel' then channel
        when 'source' then src
        when 'medium' then med
        when 'campaign' then camp
        when 'term' then term
        when 'content' then content
        else aff
      end graw
    from sel
  ),
  grouped as (
    select gkey,
      mode() within group (order by graw) raw,
      mode() within group (order by channel) channel,
      mode() within group (order by expert) expert,
      count(*) signups,
      count(*) filter (where is_ftd) ftd,
      coalesce(sum(ftd_value), 0) ftd_value,
      coalesce(sum(gross), 0) deposits,
      coalesce(sum(withdrawn), 0) withdrawals
    from keyed
    where channel <> 'sem_origem'
    group by gkey
  ),
  ranked as (
    select g.*, row_number() over (order by signups desc, ftd desc, gkey nulls last) rn
    from grouped g
  ),
  top_rows as (
    select r.*,
      -- Nome do catálogo da Meta quando o valor é ID (só nas linhas exibidas); no
      -- afiliado, o nome do expert ligado ao código.
      case
        when _group = 'affiliate' then r.expert
        when r.gkey ~ '^\d{8,25}$' and _group = 'campaign' then (
          select ma.campaign_name from public.meta_ads ma
          where ma.tenant_id = _tenant and lower(ma.campaign_id) = r.gkey
            and nullif(trim(ma.campaign_name), '') is not null limit 1)
        when r.gkey ~ '^\d{8,25}$' and _group = 'term' then (
          select ma.adset_name from public.meta_ads ma
          where ma.tenant_id = _tenant and ma.adset_id = r.gkey
            and nullif(trim(ma.adset_name), '') is not null limit 1)
        when r.gkey ~ '^\d{8,25}$' and _group = 'content' then (
          select ma.ad_name from public.meta_ads ma
          where ma.tenant_id = _tenant and lower(ma.ad_id) = r.gkey
            and nullif(trim(ma.ad_name), '') is not null limit 1)
      end meta_name
    from ranked r where r.rn <= v_limit
  ),
  crm as (
    select count(*) signups,
      count(*) filter (where is_link_crm) by_link
    from c where c.channel = 'crm'
  ),
  -- Uma passada só pela coorte (subconsulta por dia custava 2,6 s em 90 dias da pixpgf).
  by_day as (
    select (sel.created_at at time zone 'America/Sao_Paulo')::date date,
      count(*) signups,
      count(*) filter (where sel.channel <> 'sem_origem') with_origin,
      count(*) filter (where sel.is_ftd) ftd
    from sel group by 1
  ),
  daily as (
    select d::date date,
      coalesce(bd.signups, 0) signups,
      coalesce(bd.with_origin, 0) with_origin,
      coalesce(bd.ftd, 0) ftd
    from generate_series(_from::timestamp, _to::timestamp, interval '1 day') d
    left join by_day bd on bd.date = d::date
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', _from, 'to', _to),
    'group', _group,
    'filters', v_f,
    'totals', (
      select jsonb_build_object(
        'signups', count(*),
        'ftd', count(*) filter (where is_ftd),
        'ftdValue', coalesce(sum(ftd_value), 0),
        'deposits', coalesce(sum(gross), 0),
        'withdrawals', coalesce(sum(withdrawn), 0),
        'net', coalesce(sum(gross), 0) - coalesce(sum(withdrawn), 0)
      ) from sel
    ),
    'coverage', (
      select jsonb_build_object(
        'signups', count(*),
        'withUtm', count(*) filter (where channel not in ('sem_origem', 'meta_sem_campanha', 'crm', 'afiliados')),
        'affiliateOnly', count(*) filter (where channel = 'afiliados'),
        'clickOnly', count(*) filter (where channel = 'meta_sem_campanha'),
        'noOrigin', count(*) filter (where channel = 'sem_origem')
      ) from c where c.channel <> 'crm'
    ),
    'noOrigin', (
      select jsonb_build_object(
        'signups', count(*),
        'ftd', count(*) filter (where is_ftd),
        'ftdValue', coalesce(sum(ftd_value), 0),
        'deposits', coalesce(sum(gross), 0),
        'withdrawals', coalesce(sum(withdrawn), 0)
      ) from keyed where channel = 'sem_origem'
    ),
    'crm', (select jsonb_build_object('signups', signups, 'byLink', by_link) from crm),
    'totalRows', (select count(*) from grouped),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', gkey, 'raw', raw, 'channel', channel, 'metaName', meta_name,
        'signups', signups, 'ftd', ftd, 'ftdValue', ftd_value,
        'deposits', deposits, 'withdrawals', withdrawals
      ) order by rn)
      from top_rows
    ), '[]'::jsonb),
    'others', (
      select jsonb_build_object(
        'count', count(*),
        'signups', coalesce(sum(signups), 0),
        'ftd', coalesce(sum(ftd), 0),
        'ftdValue', coalesce(sum(ftd_value), 0),
        'deposits', coalesce(sum(deposits), 0),
        'withdrawals', coalesce(sum(withdrawals), 0)
      ) from ranked where rn > v_limit
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', date, 'signups', signups, 'withOrigin', with_origin, 'ftd', ftd
      ) order by date)
      from daily
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.origin_breakdown(uuid, date, date, text, jsonb, boolean, integer) from public, anon;
grant execute on function public.origin_breakdown(uuid, date, date, text, jsonb, boolean, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
