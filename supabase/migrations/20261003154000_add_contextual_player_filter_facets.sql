-- P3: calcula todos os contadores comportamentais com o mesmo recorte ativo
-- em uma unica consulta, evitando dezenas de requests concorrentes na tela.
create or replace function public.player_filter_contextual_facets_v1(
  _tenant uuid default public.current_tenant_id(),
  _filters text[] default '{}'::text[],
  _operator text default 'and',
  _gamification_status text default null,
  _gamification_level text default null,
  _search text default null,
  _date_field text default null,
  _date_from timestamptz default null,
  _date_to timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with guard as (
  select public.has_tenant_access(_tenant) or auth.role() = 'service_role' ok
), settings as (
  select
    coalesce((gs.level_thresholds->>'bronze')::numeric, 10) bronze,
    coalesce((gs.level_thresholds->>'silver')::numeric, 200) silver,
    coalesce((gs.level_thresholds->>'gold')::numeric, 500) gold,
    coalesce((gs.level_thresholds->>'diamond')::numeric, 1000) diamond,
    coalesce((gs.level_thresholds->>'black')::numeric, 3000) black,
    coalesce(gs.cooling_after_days, 2) cooling_days,
    coalesce(gs.sleeping_after_days, 7) sleeping_days,
    coalesce(gs.vip_min_level, 'diamond') vip_min_level
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
), base as (
  select p as player, case s.vip_min_level
    when 'bronze' then s.bronze when 'silver' then s.silver when 'gold' then s.gold
    when 'black' then s.black else s.diamond end vip_threshold
  from public.players p
  cross join settings s
  cross join guard g
  where g.ok and p.tenant_id = _tenant
    and (
      _gamification_status is null
      or (_gamification_status = 'active' and p.ftd_em is not null and p.ultimo_deposito >= now() - make_interval(days => s.cooling_days))
      or (_gamification_status = 'cooling' and p.ftd_em is not null and p.ultimo_deposito < now() - make_interval(days => s.cooling_days) and p.ultimo_deposito >= now() - make_interval(days => s.sleeping_days))
      or (_gamification_status = 'sleeping' and p.ftd_em is not null and p.ultimo_deposito < now() - make_interval(days => s.sleeping_days))
      or (_gamification_status = 'no_deposit' and p.ftd_em is null and coalesce(p.total_depositado, 0) <= 0)
    )
    and (
      _gamification_level is null
      or (_gamification_level = 'bronze' and coalesce(p.total_depositado, 0) >= s.bronze and coalesce(p.total_depositado, 0) < s.silver)
      or (_gamification_level = 'silver' and coalesce(p.total_depositado, 0) >= s.silver and coalesce(p.total_depositado, 0) < s.gold)
      or (_gamification_level = 'gold' and coalesce(p.total_depositado, 0) >= s.gold and coalesce(p.total_depositado, 0) < s.diamond)
      or (_gamification_level = 'diamond' and coalesce(p.total_depositado, 0) >= s.diamond and coalesce(p.total_depositado, 0) < s.black)
      or (_gamification_level = 'black' and coalesce(p.total_depositado, 0) >= s.black)
    )
    and (
      nullif(trim(coalesce(_search, '')), '') is null
      or p.nome ilike '%' || replace(replace(replace(replace(replace(trim(_search), '\\', ' '), '%', ' '), ',', ' '), '(', ' '), ')', ' ') || '%'
      or p.telefone ilike '%' || replace(replace(replace(replace(replace(trim(_search), '\\', ' '), '%', ' '), ',', ' '), '(', ' '), ')', ' ') || '%'
      or p.email ilike '%' || replace(replace(replace(replace(replace(trim(_search), '\\', ' '), '%', ' '), ',', ' '), '(', ' '), ')', ' ') || '%'
      or p.player_external_id ilike '%' || replace(replace(replace(replace(replace(trim(_search), '\\', ' '), '%', ' '), ',', ' '), '(', ' '), ')', ' ') || '%'
    )
    and (_date_field not in ('created_at', 'ftd_em') or _date_from is null or _date_to is null
      or (_date_field = 'created_at' and p.created_at between _date_from and _date_to)
      or (_date_field = 'ftd_em' and p.ftd_em between _date_from and _date_to))
), counts as (
  select f.filter_id, count(*) filter (where public.player_matches_behavior_filters(
    b.player,
    case when f.filter_id = any(_filters) then _filters else array_append(_filters, f.filter_id) end,
    _operator,
    b.vip_threshold
  ))::integer total
  from base b
  cross join unnest(array[
    'ativo','cashback_pago_hoje','recorrentes','risco_5_7','em_risco','vip','vip_em_risco','quase_vip',
    'leads_quentes','com_saldo','deposito_hoje','ftd_hoje','nao_converteram','risco_inicial','risco_moderado',
    'risco_alto','quase_perdido','recuperacao_dificil','perdidos'
  ]) as f(filter_id)
  group by f.filter_id
)
select coalesce(jsonb_object_agg(filter_id, total), '{}'::jsonb) from counts;
$$;

revoke all on function public.player_filter_contextual_facets_v1(uuid, text[], text, text, text, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.player_filter_contextual_facets_v1(uuid, text[], text, text, text, text, text, timestamptz, timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
