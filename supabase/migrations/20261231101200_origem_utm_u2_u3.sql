-- U2 + U3 de ESCOPO_ORIGEM_UTM_2026-11-14.
--   U2: apelidos por casa (tenant_utm_labels) e regras de canal por casa
--       (tenant_channel_rules), gravados só por RPC de admin/gestor.
--   U3: lista de jogadores de uma linha (origin_breakdown_players) e depósito líquido
--       em 7 e 30 dias da coorte madura.
-- origin_breakdown passa a ler de duas funções internas: origin_signups (cada
-- cadastro com o canal, já com as regras da casa) e origin_cohort (filtros e dinheiro).
-- Depende de 20261231101000 (attribution_channel) e 20261231101100 (referral_code).

-- ---------------------------------------------------------------------------
-- U2: apelidos e regras
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_utm_labels (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dimension text not null check (dimension in ('source', 'medium', 'campaign', 'term', 'content', 'affiliate')),
  value_norm text not null check (value_norm = lower(trim(value_norm)) and value_norm <> ''),
  label text not null check (length(trim(label)) between 1 and 120),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, dimension, value_norm)
);

alter table public.tenant_utm_labels enable row level security;
drop policy if exists tenant_utm_labels_read on public.tenant_utm_labels;
create policy tenant_utm_labels_read on public.tenant_utm_labels
  for select to authenticated using (public.has_tenant_access(tenant_id));
revoke all on public.tenant_utm_labels from anon, authenticated;
grant select on public.tenant_utm_labels to authenticated;
grant all on public.tenant_utm_labels to service_role;

create table if not exists public.tenant_channel_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  field text not null check (field in ('source', 'medium', 'campaign')),
  match text not null check (match in ('exact', 'prefix', 'contains')),
  pattern text not null check (pattern = lower(trim(pattern)) and pattern <> '' and length(pattern) <= 120),
  channel text not null check (channel in (
    'meta', 'live', 'google', 'tiktok', 'kwai', 'whatsapp', 'telegram', 'mensagens',
    'busca', 'afiliados', 'influencer', 'outros')),
  priority integer not null default 100,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, field, match, pattern)
);

create index if not exists tenant_channel_rules_tenant_idx
  on public.tenant_channel_rules (tenant_id, priority, created_at);

alter table public.tenant_channel_rules enable row level security;
drop policy if exists tenant_channel_rules_read on public.tenant_channel_rules;
create policy tenant_channel_rules_read on public.tenant_channel_rules
  for select to authenticated using (public.has_tenant_access(tenant_id));
revoke all on public.tenant_channel_rules from anon, authenticated;
grant select on public.tenant_channel_rules to authenticated;
grant all on public.tenant_channel_rules to service_role;

-- Admin ou gestor da casa (ou super admin, via is_tenant_admin).
create or replace function public.can_edit_origin_labels(_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_tenant_admin(_tenant) or exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and tenant_id = _tenant and role = 'gestor'
  )
$$;

revoke all on function public.can_edit_origin_labels(uuid) from public, anon;
grant execute on function public.can_edit_origin_labels(uuid) to authenticated, service_role;

-- Apelido vazio apaga.
create or replace function public.set_utm_label(
  _tenant uuid,
  _dimension text,
  _value text,
  _label text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value text := lower(trim(coalesce(_value, '')));
  v_label text := nullif(trim(coalesce(_label, '')), '');
begin
  if not (public.can_edit_origin_labels(_tenant) or auth.role() = 'service_role') then
    raise exception 'Só o administrador ou o gestor da casa dá nome às origens.' using errcode = '42501';
  end if;
  if _dimension is null or _dimension not in ('source', 'medium', 'campaign', 'term', 'content', 'affiliate') then
    raise exception 'Nível inválido.' using errcode = '22023';
  end if;
  if v_value = '' or length(v_value) > 500 then
    raise exception 'Valor inválido.' using errcode = '22023';
  end if;
  if v_label is not null and length(v_label) > 120 then
    raise exception 'O nome pode ter até 120 caracteres.' using errcode = '22023';
  end if;

  if v_label is null then
    delete from public.tenant_utm_labels
    where tenant_id = _tenant and dimension = _dimension and value_norm = v_value;
  else
    insert into public.tenant_utm_labels (tenant_id, dimension, value_norm, label, updated_by, updated_at)
    values (_tenant, _dimension, v_value, v_label, auth.uid(), now())
    on conflict (tenant_id, dimension, value_norm)
      do update set label = excluded.label, updated_by = excluded.updated_by, updated_at = now();
  end if;

  return jsonb_build_object('dimension', _dimension, 'value', v_value, 'label', v_label);
end;
$$;

revoke all on function public.set_utm_label(uuid, text, text, text) from public, anon;
grant execute on function public.set_utm_label(uuid, text, text, text) to authenticated, service_role;

create or replace function public.upsert_channel_rule(
  _tenant uuid,
  _field text,
  _match text,
  _pattern text,
  _channel text,
  _priority integer default 100
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_pattern text := lower(trim(coalesce(_pattern, '')));
begin
  if not (public.can_edit_origin_labels(_tenant) or auth.role() = 'service_role') then
    raise exception 'Só o administrador ou o gestor da casa muda as regras de canal.' using errcode = '42501';
  end if;
  if v_pattern = '' or length(v_pattern) > 120 then
    raise exception 'Texto da regra inválido.' using errcode = '22023';
  end if;
  insert into public.tenant_channel_rules (tenant_id, field, match, pattern, channel, priority, created_by)
  values (_tenant, _field, _match, v_pattern, _channel, coalesce(_priority, 100), auth.uid())
  on conflict (tenant_id, field, match, pattern)
    do update set channel = excluded.channel, priority = excluded.priority
  returning id into v_id;
  return v_id;
exception
  when check_violation then
    raise exception 'Regra inválida.' using errcode = '22023';
end;
$$;

revoke all on function public.upsert_channel_rule(uuid, text, text, text, text, integer) from public, anon;
grant execute on function public.upsert_channel_rule(uuid, text, text, text, text, integer)
  to authenticated, service_role;

create or replace function public.delete_channel_rule(_tenant uuid, _id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.can_edit_origin_labels(_tenant) or auth.role() = 'service_role') then
    raise exception 'Só o administrador ou o gestor da casa muda as regras de canal.' using errcode = '42501';
  end if;
  delete from public.tenant_channel_rules where tenant_id = _tenant and id = _id;
  return found;
end;
$$;

revoke all on function public.delete_channel_rule(uuid, uuid) from public, anon;
grant execute on function public.delete_channel_rule(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Funções internas (sem grant para authenticated; chamadas pelas RPCs abaixo)
-- ---------------------------------------------------------------------------

-- Cada cadastro do intervalo com o canal: link do CRM > regra da casa > regra padrão;
-- sem UTM mas com afiliado ou código de indicação = afiliados.
create or replace function public.origin_signups(_tenant uuid, _from timestamptz, _to timestamptz)
returns table (
  id uuid, nome text, created_at timestamptz, ftd_em timestamptz,
  src text, med text, camp text, term text, content text,
  aff text, ref text, expert text, channel text
)
language sql
stable
set search_path = public
as $$
  with
  base as (
    select
      p.id, p.nome, p.created_at, p.ftd_em,
      nullif(trim(p.affiliate_id), '') aff,
      nullif(trim(p.referral_code), '') ref,
      nullif(trim(p.expert), '') expert,
      nullif(trim(coalesce(pa.utm_source, p.utm_source)), '') src,
      nullif(trim(coalesce(pa.utm_medium, p.utm_medium)), '') med,
      nullif(trim(coalesce(pa.utm_campaign, p.utm_campaign)), '') camp,
      nullif(trim(coalesce(pa.utm_term, p.utm_term)), '') term,
      nullif(trim(coalesce(pa.utm_content, p.utm_content)), '') content,
      coalesce(nullif(trim(pa.fbclid), ''), '') <> '' has_fb,
      coalesce(nullif(trim(pa.gclid), ''), nullif(trim(pa.gbraid), ''), nullif(trim(pa.wbraid), ''), '') <> '' has_g,
      coalesce(nullif(trim(pa.ttclid), ''), '') <> '' has_tt,
      -- O link do SMS pode levar a utm_source da casa; o bl_click_id é a chave confiável.
      pa.bl_click_id is not null is_link_crm
    from public.players p
    left join public.player_attributions pa
      on pa.tenant_id = p.tenant_id and pa.player_id = p.id and pa.event_type = 'signup'
    where p.tenant_id = _tenant and p.created_at >= _from and p.created_at < _to
  ),
  rules as (
    select r.field, r.match, r.pattern, r.channel, r.priority, r.created_at
    from public.tenant_channel_rules r where r.tenant_id = _tenant
  ),
  -- Regras uma vez por combinação de valores (centenas), não por cadastro (milhares).
  vals as (
    select distinct coalesce(lower(b.src), '') s, coalesce(lower(b.med), '') m, coalesce(lower(b.camp), '') c
    from base b
  ),
  ruled as (
    select v.*, (
      select r.channel from rules r
      where (case r.field when 'source' then v.s when 'medium' then v.m else v.c end) <> ''
        and case r.match
          when 'exact' then (case r.field when 'source' then v.s when 'medium' then v.m else v.c end) = r.pattern
          when 'prefix' then left(case r.field when 'source' then v.s when 'medium' then v.m else v.c end,
                                  length(r.pattern)) = r.pattern
          else strpos(case r.field when 'source' then v.s when 'medium' then v.m else v.c end, r.pattern) > 0
        end
      order by r.priority, r.created_at
      limit 1
    ) rule_channel
    from vals v
  )
  select b.id, b.nome, b.created_at, b.ftd_em, b.src, b.med, b.camp, b.term, b.content,
    b.aff, b.ref, b.expert,
    case
      when b.is_link_crm or d.v = 'crm' then 'crm'
      when ru.rule_channel is not null then ru.rule_channel
      when d.v = 'sem_origem' and (b.aff is not null or b.ref is not null) then 'afiliados'
      else d.v
    end channel
  from base b
  join ruled ru
    on ru.s = coalesce(lower(b.src), '') and ru.m = coalesce(lower(b.med), '') and ru.c = coalesce(lower(b.camp), '')
  cross join lateral (
    select public.attribution_channel(
      b.src, b.med, coalesce(b.camp, b.term, b.content) is not null, b.has_fb, b.has_g, b.has_tt) v
  ) d
$$;

revoke all on function public.origin_signups(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.origin_signups(uuid, timestamptz, timestamptz) to service_role;

-- Filtros (caminho, busca, inclusive no apelido, só 1º depósito) e o dinheiro de cada
-- cadastro desde o cadastro até hoje, mais as janelas de 7 e 30 dias.
create or replace function public.origin_cohort(
  _tenant uuid, _from timestamptz, _to timestamptz, _filters jsonb, _include_crm boolean
)
returns table (
  id uuid, nome text, created_at timestamptz,
  src text, med text, camp text, term text, content text,
  aff text, ref text, expert text, channel text,
  is_ftd boolean, ftd_value numeric, gross numeric, withdrawn numeric,
  net7 numeric, net30 numeric, mature7 boolean, mature30 boolean
)
language sql
stable
set search_path = public
as $$
  with
  opts as (
    select coalesce(_filters, '{}'::jsonb) f,
           nullif(lower(trim(_filters->>'search')), '') search,
           coalesce((_filters->>'onlyFtd')::boolean, false) only_ftd
  ),
  label_hits as (
    select l.dimension, l.value_norm
    from public.tenant_utm_labels l, opts o
    where l.tenant_id = _tenant and o.search is not null and strpos(lower(l.label), o.search) > 0
  ),
  f as (
    select s.* from public.origin_signups(_tenant, _from, _to) s, opts o
    where (_include_crm or s.channel <> 'crm')
      and (not (o.f ? 'channel') or s.channel is not distinct from (o.f->>'channel'))
      and (not (o.f ? 'source') or lower(s.src) is not distinct from lower(o.f->>'source'))
      and (not (o.f ? 'medium') or lower(s.med) is not distinct from lower(o.f->>'medium'))
      and (not (o.f ? 'campaign') or lower(s.camp) is not distinct from lower(o.f->>'campaign'))
      and (not (o.f ? 'term') or lower(s.term) is not distinct from lower(o.f->>'term'))
      and (not (o.f ? 'content') or lower(s.content) is not distinct from lower(o.f->>'content'))
      and (not (o.f ? 'affiliate')
           or coalesce(lower(s.aff), case when s.ref is not null then '__indicacao__' end)
              is not distinct from lower(o.f->>'affiliate'))
      and (o.search is null
           or strpos(lower(concat_ws(' ', s.src, s.med, s.camp, s.term, s.content, s.aff, s.ref, s.expert)),
                     o.search) > 0
           or exists (
             select 1 from label_hits h
             where (h.dimension = 'source' and h.value_norm = lower(s.src))
                or (h.dimension = 'medium' and h.value_norm = lower(s.med))
                or (h.dimension = 'campaign' and h.value_norm = lower(s.camp))
                or (h.dimension = 'term' and h.value_norm = lower(s.term))
                or (h.dimension = 'content' and h.value_norm = lower(s.content))
                or (h.dimension = 'affiliate' and h.value_norm = lower(s.aff))))
  ),
  m as (
    select f.id, f.nome, f.created_at, f.src, f.med, f.camp, f.term, f.content,
      f.aff, f.ref, f.expert, f.channel,
      coalesce(d.is_ftd, false) is_ftd,
      coalesce(d.ftd_value, 0) ftd_value,
      coalesce(d.gross, 0) gross,
      coalesce(w.withdrawn, 0) withdrawn,
      coalesce(d.gross7, 0) - coalesce(w.w7, 0) net7,
      coalesce(d.gross30, 0) - coalesce(w.w30, 0) net30,
      f.created_at <= now() - interval '7 days' mature7,
      f.created_at <= now() - interval '30 days' mature30
    from f
    left join lateral (
      select sum(x.valor) gross,
             sum(x.valor) filter (where x.first_real) ftd_value,
             bool_or(x.first_real) is_ftd,
             sum(x.valor) filter (where x.created_at < f.created_at + interval '7 days') gross7,
             sum(x.valor) filter (where x.created_at < f.created_at + interval '30 days') gross30
      from (
        select dd.valor, dd.created_at,
               row_number() over (order by dd.created_at, dd.id) = 1
                 and (f.ftd_em is null or f.ftd_em >= dd.created_at - interval '10 minutes') first_real
        from public.deposits dd
        where dd.tenant_id = _tenant and dd.player_id = f.id and dd.status = 'aprovado'
      ) x
    ) d on true
    left join lateral (
      select sum(ww.valor) withdrawn,
             sum(ww.valor) filter (where ww.created_at < f.created_at + interval '7 days') w7,
             sum(ww.valor) filter (where ww.created_at < f.created_at + interval '30 days') w30
      from public.withdrawals ww
      where ww.tenant_id = _tenant and ww.player_id = f.id and ww.status = 'aprovado'
    ) w on true
  )
  select m.* from m, opts o where not o.only_ftd or m.is_ftd
$$;

revoke all on function public.origin_cohort(uuid, timestamptz, timestamptz, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.origin_cohort(uuid, timestamptz, timestamptz, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- RPCs de leitura
-- ---------------------------------------------------------------------------
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
  v_limit integer;
  v_unfiltered boolean;
  v_coverage jsonb;
  v_crm jsonb;
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
  v_limit := least(greatest(coalesce(_limit, 100), 1), 500);
  v_unfiltered := v_f = '{}'::jsonb;

  -- Cobertura e CRM valem para o período inteiro, sem os filtros. Com filtro, uma
  -- leitura à parte só da classificação (sem depósitos).
  if not v_unfiltered then
    select
      jsonb_build_object(
        'signups', count(*) filter (where s.channel <> 'crm'),
        'withUtm', count(*) filter (where s.channel not in ('sem_origem', 'meta_sem_campanha', 'crm', 'afiliados')),
        'affiliateOnly', count(*) filter (where s.channel = 'afiliados'),
        'clickOnly', count(*) filter (where s.channel = 'meta_sem_campanha'),
        'noOrigin', count(*) filter (where s.channel = 'sem_origem')),
      jsonb_build_object('signups', count(*) filter (where s.channel = 'crm'))
    into v_coverage, v_crm
    from public.origin_signups(_tenant, v_from, v_to) s;
  end if;

  with
  -- Sem filtro, o CRM vem junto para a contagem e sai logo abaixo.
  co as (
    select * from public.origin_cohort(_tenant, v_from, v_to, v_f, _include_crm or v_unfiltered)
  ),
  sel as (
    select * from co where _include_crm or co.channel <> 'crm'
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
        else coalesce(lower(aff), case when ref is not null then '__indicacao__' end)
      end gkey,
      case _group
        when 'channel' then channel
        when 'source' then src
        when 'medium' then med
        when 'campaign' then camp
        when 'term' then term
        when 'content' then content
        else coalesce(aff, case when ref is not null then '__indicacao__' end)
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
      coalesce(sum(withdrawn), 0) withdrawals,
      count(*) filter (where mature7) mature7,
      coalesce(sum(net7) filter (where mature7), 0) net7,
      count(*) filter (where mature30) mature30,
      coalesce(sum(net30) filter (where mature30), 0) net30
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
      case when _group <> 'channel' and r.gkey is not null then (
        select l.label from public.tenant_utm_labels l
        where l.tenant_id = _tenant and l.dimension = _group and l.value_norm = r.gkey)
      end label,
      -- Nome do catálogo da Meta quando o valor é ID; no afiliado, o expert do código.
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
        'net', coalesce(sum(gross), 0) - coalesce(sum(withdrawn), 0),
        'mature7', count(*) filter (where mature7),
        'net7', coalesce(sum(net7) filter (where mature7), 0),
        'mature30', count(*) filter (where mature30),
        'net30', coalesce(sum(net30) filter (where mature30), 0)
      ) from sel
    ),
    'coverage', coalesce(v_coverage, (
      select jsonb_build_object(
        'signups', count(*) filter (where channel <> 'crm'),
        'withUtm', count(*) filter (where channel not in ('sem_origem', 'meta_sem_campanha', 'crm', 'afiliados')),
        'affiliateOnly', count(*) filter (where channel = 'afiliados'),
        'clickOnly', count(*) filter (where channel = 'meta_sem_campanha'),
        'noOrigin', count(*) filter (where channel = 'sem_origem')
      ) from co
    )),
    'noOrigin', (
      select jsonb_build_object(
        'signups', count(*),
        'ftd', count(*) filter (where is_ftd),
        'ftdValue', coalesce(sum(ftd_value), 0),
        'deposits', coalesce(sum(gross), 0),
        'withdrawals', coalesce(sum(withdrawn), 0),
        'mature7', count(*) filter (where mature7),
        'net7', coalesce(sum(net7) filter (where mature7), 0),
        'mature30', count(*) filter (where mature30),
        'net30', coalesce(sum(net30) filter (where mature30), 0)
      ) from keyed where channel = 'sem_origem'
    ),
    'crm', coalesce(v_crm, (
      select jsonb_build_object('signups', count(*)) from co where channel = 'crm'
    )),
    'canEdit', public.can_edit_origin_labels(_tenant),
    'totalRows', (select count(*) from grouped),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', gkey, 'raw', raw, 'channel', channel, 'metaName', meta_name, 'label', label,
        'signups', signups, 'ftd', ftd, 'ftdValue', ftd_value,
        'deposits', deposits, 'withdrawals', withdrawals,
        'mature7', mature7, 'net7', net7, 'mature30', mature30, 'net30', net30
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
        'withdrawals', coalesce(sum(withdrawals), 0),
        'mature7', coalesce(sum(mature7), 0),
        'net7', coalesce(sum(net7), 0),
        'mature30', coalesce(sum(mature30), 0),
        'net30', coalesce(sum(net30), 0)
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

-- U3: os jogadores por trás de uma linha (mesmo caminho, busca e filtros).
create or replace function public.origin_breakdown_players(
  _tenant uuid,
  _from date,
  _to date,
  _filters jsonb default '{}'::jsonb,
  _include_crm boolean default false,
  _limit integer default 50,
  _offset integer default 0
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
  v_limit integer := least(greatest(coalesce(_limit, 50), 1), 2000);
  v_offset integer := greatest(coalesce(_offset, 0), 0);
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
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'Filtro inválido.' using errcode = '22023';
  end if;

  v_from := (_from::timestamp at time zone 'America/Sao_Paulo');
  v_to := ((_to + 1)::timestamp at time zone 'America/Sao_Paulo');

  with co as (
    select * from public.origin_cohort(_tenant, v_from, v_to, v_f, _include_crm)
  ),
  page as (
    select * from co order by gross desc, created_at desc, id limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from co),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'nome', nome, 'createdAt', created_at, 'channel', channel,
        'source', src, 'medium', med, 'campaign', camp, 'term', term, 'content', content,
        'affiliate', aff, 'referral', ref, 'expert', expert,
        'ftd', is_ftd, 'ftdValue', ftd_value, 'deposits', gross, 'withdrawals', withdrawn
      ) order by gross desc, created_at desc, id)
      from page
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.origin_breakdown_players(uuid, date, date, jsonb, boolean, integer, integer) from public, anon;
grant execute on function public.origin_breakdown_players(uuid, date, date, jsonb, boolean, integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
