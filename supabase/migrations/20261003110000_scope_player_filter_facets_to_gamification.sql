create or replace function public.player_filter_facets_v1(
  _tenant uuid default public.current_tenant_id(),
  _gamification_status text default null,
  _gamification_level text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
guard as (
  select public.has_tenant_access(_tenant) or auth.role() = 'service_role' ok
),
clock as (
  select
    now() current_time,
    (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') brt_today
),
settings as (
  select
    coalesce((level_thresholds->>'bronze')::numeric, 10) bronze,
    coalesce((level_thresholds->>'silver')::numeric, 200) silver,
    coalesce((level_thresholds->>'gold')::numeric, 500) gold,
    coalesce((level_thresholds->>'diamond')::numeric, 1000) diamond,
    coalesce((level_thresholds->>'black')::numeric, 3000) black,
    coalesce(cooling_after_days, 2) cooling_after_days,
    coalesce(sleeping_after_days, 7) sleeping_after_days,
    coalesce(vip_min_level, 'diamond') vip_min_level
  from (select 1) seed
  left join public.gamification_settings gs on gs.tenant_id = _tenant
),
base as (
  select
    p.ultimo_login,
    p.ultimo_jogo,
    p.ultimo_deposito,
    p.ftd_em,
    p.last_cashback_paid_at,
    coalesce(p.total_depositado, 0)::numeric total_depositado,
    coalesce(p.saldo_carteira, 0)::numeric saldo_carteira,
    coalesce(p.saldo_bonus, 0)::numeric saldo_bonus,
    coalesce(p.vip, false) vip,
    case s.vip_min_level
      when 'bronze' then s.bronze when 'silver' then s.silver when 'gold' then s.gold
      when 'black' then s.black else s.diamond
    end vip_threshold
  from public.players p
  cross join settings s
  cross join clock c
  where p.tenant_id = _tenant
    and (
      _gamification_status is null
      or (_gamification_status = 'active' and p.ftd_em is not null and p.ultimo_deposito >= c.current_time - make_interval(days => s.cooling_after_days))
      or (_gamification_status = 'cooling' and p.ftd_em is not null and p.ultimo_deposito < c.current_time - make_interval(days => s.cooling_after_days) and p.ultimo_deposito >= c.current_time - make_interval(days => s.sleeping_after_days))
      or (_gamification_status = 'sleeping' and p.ftd_em is not null and p.ultimo_deposito < c.current_time - make_interval(days => s.sleeping_after_days))
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
),
facets as (
  select jsonb_build_object(
    'recorrentes', count(*) filter (where b.ultimo_login >= c.current_time - interval '4 days' or b.ultimo_jogo >= c.current_time - interval '4 days' or b.ultimo_deposito >= c.current_time - interval '4 days'),
    'cashback_pago_hoje', count(*) filter (where b.last_cashback_paid_at >= c.brt_today),
    'deposito_hoje', count(*) filter (where b.ultimo_deposito >= c.brt_today),
    'ftd_hoje', count(*) filter (where b.ftd_em >= c.brt_today),
    'leads_quentes', count(*) filter (where (b.ultimo_login >= c.current_time - interval '4 days' or b.ultimo_jogo >= c.current_time - interval '4 days' or b.ultimo_deposito >= c.current_time - interval '4 days') and b.ultimo_deposito >= c.current_time - interval '7 days'),
    'com_saldo', count(*) filter (where (b.ultimo_login >= c.current_time - interval '60 days' or b.ultimo_jogo >= c.current_time - interval '60 days' or b.ultimo_deposito >= c.current_time - interval '60 days') and (b.saldo_carteira > 0 or b.saldo_bonus > 0)),
    'vip', count(*) filter (where b.vip or b.total_depositado >= b.vip_threshold),
    'quase_vip', count(*) filter (where not b.vip and b.total_depositado >= b.vip_threshold * 0.7 and b.total_depositado < b.vip_threshold),
    'risco_5_7', count(*) filter (where b.ultimo_login < c.current_time - interval '5 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '5 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '5 days') and (b.ultimo_login >= c.current_time - interval '7 days' or b.ultimo_jogo >= c.current_time - interval '7 days' or b.ultimo_deposito >= c.current_time - interval '7 days')),
    'em_risco', count(*) filter (where b.ultimo_login < c.current_time - interval '7 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '7 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '7 days')),
    'vip_em_risco', count(*) filter (where (b.vip or b.total_depositado >= b.vip_threshold) and b.ultimo_login < c.current_time - interval '7 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '7 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '7 days')),
    'risco_inicial', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '7 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '7 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '7 days') and (b.ultimo_login >= c.current_time - interval '14 days' or b.ultimo_jogo >= c.current_time - interval '14 days' or b.ultimo_deposito >= c.current_time - interval '14 days')),
    'risco_moderado', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '15 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '15 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '15 days') and (b.ultimo_login >= c.current_time - interval '24 days' or b.ultimo_jogo >= c.current_time - interval '24 days' or b.ultimo_deposito >= c.current_time - interval '24 days')),
    'risco_alto', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '25 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '25 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '25 days') and (b.ultimo_login >= c.current_time - interval '34 days' or b.ultimo_jogo >= c.current_time - interval '34 days' or b.ultimo_deposito >= c.current_time - interval '34 days')),
    'quase_perdido', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '35 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '35 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '35 days') and (b.ultimo_login >= c.current_time - interval '44 days' or b.ultimo_jogo >= c.current_time - interval '44 days' or b.ultimo_deposito >= c.current_time - interval '44 days')),
    'recuperacao_dificil', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '45 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '45 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '45 days') and (b.ultimo_login >= c.current_time - interval '59 days' or b.ultimo_jogo >= c.current_time - interval '59 days' or b.ultimo_deposito >= c.current_time - interval '59 days')),
    'perdidos', count(*) filter (where b.ftd_em is not null and b.ultimo_login < c.current_time - interval '60 days' and (b.ultimo_jogo is null or b.ultimo_jogo < c.current_time - interval '60 days') and (b.ultimo_deposito is null or b.ultimo_deposito < c.current_time - interval '60 days'))
  ) value
  from base b cross join clock c
)
select f.value from guard g cross join facets f where g.ok;
$$;

revoke all on function public.player_filter_facets_v1(uuid, text, text) from public, anon;
grant execute on function public.player_filter_facets_v1(uuid, text, text) to authenticated, service_role;
