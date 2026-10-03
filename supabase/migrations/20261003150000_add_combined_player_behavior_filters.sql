-- P2: filtros comportamentais compostos para a lista de players.
-- A funcao retorna SETOF players para que PostgREST mantenha paginação,
-- ordenação e os filtros adicionais (busca, nivel, situacao e periodo).

create or replace function public.player_matches_behavior_filters(
  p public.players,
  _filters text[] default '{}'::text[],
  _operator text default 'and',
  _vip_threshold numeric default 1000
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  filter_id text;
  matched boolean;
  aggregate_match boolean := case when lower(coalesce(_operator, 'and')) = 'or' then false else true end;
  now_brt timestamptz := now();
  today_start_brt timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  activity_4d boolean := p.ultimo_login >= now_brt - interval '4 days'
    or p.ultimo_jogo >= now_brt - interval '4 days'
    or p.ultimo_deposito >= now_brt - interval '4 days';
  activity_7d boolean := p.ultimo_login >= now_brt - interval '7 days'
    or p.ultimo_jogo >= now_brt - interval '7 days'
    or p.ultimo_deposito >= now_brt - interval '7 days';
  activity_14d boolean := p.ultimo_login >= now_brt - interval '14 days'
    or p.ultimo_jogo >= now_brt - interval '14 days'
    or p.ultimo_deposito >= now_brt - interval '14 days';
  activity_24d boolean := p.ultimo_login >= now_brt - interval '24 days'
    or p.ultimo_jogo >= now_brt - interval '24 days'
    or p.ultimo_deposito >= now_brt - interval '24 days';
  activity_34d boolean := p.ultimo_login >= now_brt - interval '34 days'
    or p.ultimo_jogo >= now_brt - interval '34 days'
    or p.ultimo_deposito >= now_brt - interval '34 days';
  activity_44d boolean := p.ultimo_login >= now_brt - interval '44 days'
    or p.ultimo_jogo >= now_brt - interval '44 days'
    or p.ultimo_deposito >= now_brt - interval '44 days';
  activity_59d boolean := p.ultimo_login >= now_brt - interval '59 days'
    or p.ultimo_jogo >= now_brt - interval '59 days'
    or p.ultimo_deposito >= now_brt - interval '59 days';
  activity_60d boolean := p.ultimo_login >= now_brt - interval '60 days'
    or p.ultimo_jogo >= now_brt - interval '60 days'
    or p.ultimo_deposito >= now_brt - interval '60 days';
  inactive_5d boolean := p.ultimo_login < now_brt - interval '5 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '5 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '5 days');
  inactive_7d boolean := p.ultimo_login < now_brt - interval '7 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '7 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '7 days');
  inactive_15d boolean := p.ultimo_login < now_brt - interval '15 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '15 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '15 days');
  inactive_25d boolean := p.ultimo_login < now_brt - interval '25 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '25 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '25 days');
  inactive_35d boolean := p.ultimo_login < now_brt - interval '35 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '35 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '35 days');
  inactive_45d boolean := p.ultimo_login < now_brt - interval '45 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '45 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '45 days');
  inactive_60d boolean := p.ultimo_login < now_brt - interval '60 days'
    and (p.ultimo_jogo is null or p.ultimo_jogo < now_brt - interval '60 days')
    and (p.ultimo_deposito is null or p.ultimo_deposito < now_brt - interval '60 days');
begin
  if coalesce(array_length(_filters, 1), 0) = 0 then return true; end if;

  foreach filter_id in array _filters loop
    matched := case filter_id
      when 'recorrentes' then activity_4d
      when 'ativo' then p.ftd_em is not null
      when 'em_risco' then inactive_7d
      when 'risco_5_7' then inactive_5d and activity_7d
      when 'vip' then p.vip = true or p.total_depositado >= _vip_threshold
      when 'vip_em_risco' then (p.vip = true or p.total_depositado >= _vip_threshold) and inactive_7d
      when 'quase_vip' then p.vip = false and p.total_depositado >= _vip_threshold * 0.7 and p.total_depositado < _vip_threshold
      when 'leads_quentes' then activity_4d and p.ultimo_deposito >= now_brt - interval '7 days'
      when 'com_saldo' then activity_60d and (p.saldo_carteira > 0 or p.saldo_bonus > 0)
      when 'deposito_hoje' then p.ultimo_deposito >= today_start_brt
      when 'ftd_hoje' then p.ftd_em >= today_start_brt
      when 'nao_converteram' then p.ftd_em is null
      when 'risco_inicial' then inactive_7d and activity_14d and p.ftd_em is not null
      when 'risco_moderado' then inactive_15d and activity_24d and p.ftd_em is not null
      when 'risco_alto' then inactive_25d and activity_34d and p.ftd_em is not null
      when 'quase_perdido' then inactive_35d and activity_44d and p.ftd_em is not null
      when 'recuperacao_dificil' then inactive_45d and activity_59d and p.ftd_em is not null
      when 'perdidos' then inactive_60d and p.ftd_em is not null
      when 'cashback_pago_hoje' then p.last_cashback_paid_at >= today_start_brt
      else false
    end;

    if lower(coalesce(_operator, 'and')) = 'or' then
      aggregate_match := aggregate_match or coalesce(matched, false);
      if aggregate_match then return true; end if;
    else
      aggregate_match := aggregate_match and coalesce(matched, false);
      if not aggregate_match then return false; end if;
    end if;
  end loop;
  return aggregate_match;
end;
$$;

create or replace function public.players_by_behavior_filters(
  _filters text[] default '{}'::text[],
  _operator text default 'and',
  _vip_threshold numeric default 1000
)
returns setof public.players
language sql
stable
security invoker
set search_path = public
as $$
  select p.*
  from public.players p
  where public.player_matches_behavior_filters(p, _filters, _operator, _vip_threshold);
$$;

grant execute on function public.player_matches_behavior_filters(public.players, text[], text, numeric) to authenticated;
grant execute on function public.players_by_behavior_filters(text[], text, numeric) to authenticated;
