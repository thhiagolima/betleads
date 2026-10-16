-- P3 (E-02 / UX): how many players would enter a journey right now if it were
-- published "including the current base", so the operator sees the impact
-- (players, SMS per day, cost per day) before publishing.
--
-- Mirrors the entry rules of the supported triggers:
--   inactivity               field within [hours, upper bound) — upper bound is
--                            trigger_config.hours_max or exit_rules.inactivity_over_hours
--   cadastrados_sem_deposito players without a first deposit
--   pix_gerado_nao_pago      players with a pending PIX younger than expire_hours (72 h)
-- Other triggers (level, events, manual) return null: they only take new cases.
-- Players already open in the journey and, for SMS-only journeys, players
-- without a phone are not counted (they would not enter).

create or replace function public.journey_activation_estimate(_journey uuid)
returns table (eligible bigint, supported boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j record;
  v_field text;
  v_hours numeric;
  v_max numeric;
  v_expire numeric;
  v_needs_phone boolean;
begin
  select * into j from public.journeys where id = _journey;
  if not found or not (public.has_tenant_access(j.tenant_id) or auth.role() = 'service_role') then
    return;
  end if;
  v_needs_phone := public.journey_requires_phone(_journey);

  if j.trigger_type = 'inactivity' then
    v_field := coalesce(j.trigger_config->>'field', 'ultimo_login');
    v_hours := nullif(j.trigger_config->>'hours', '')::numeric;
    v_max := coalesce(
      nullif(j.trigger_config->>'hours_max', '')::numeric,
      nullif(j.exit_rules->>'inactivity_over_hours', '')::numeric
    );
    if v_hours is null or v_field not in ('ultimo_login', 'ultimo_jogo', 'ultimo_deposito') then
      return query select null::bigint, false;
      return;
    end if;
    return query
    select count(*), true
    from public.players p
    where p.tenant_id = j.tenant_id
      and (case v_field when 'ultimo_login' then p.ultimo_login
                        when 'ultimo_jogo' then p.ultimo_jogo
                        else p.ultimo_deposito end) <= now() - make_interval(secs => (v_hours * 3600)::double precision)
      and (v_max is null or v_max <= v_hours or
           (case v_field when 'ultimo_login' then p.ultimo_login
                         when 'ultimo_jogo' then p.ultimo_jogo
                         else p.ultimo_deposito end) > now() - make_interval(secs => (v_max * 3600)::double precision))
      and (not v_needs_phone or coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') <> '')
      and not exists (
        select 1 from public.journey_enrollments e
        where e.journey_id = _journey and e.player_id = p.id
          and e.status in ('active', 'waiting', 'paused_by_priority'));
  elsif j.trigger_type = 'cadastrados_sem_deposito' then
    return query
    select count(*), true
    from public.players p
    where p.tenant_id = j.tenant_id and p.ftd_em is null and coalesce(p.total_depositado, 0) = 0
      and (not v_needs_phone or coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') <> '')
      and not exists (
        select 1 from public.journey_enrollments e
        where e.journey_id = _journey and e.player_id = p.id);
  elsif j.trigger_type = 'pix_gerado_nao_pago' then
    v_expire := coalesce(nullif(j.trigger_config->>'expire_hours', '')::numeric, 72);
    return query
    select count(distinct d.player_id), true
    from public.deposits d
    join public.players p on p.id = d.player_id
    where d.tenant_id = j.tenant_id and d.status = 'pendente' and d.metodo ilike '%pix%'
      and (v_expire <= 0 or d.created_at >= now() - make_interval(secs => (v_expire * 3600)::double precision))
      and (not v_needs_phone or coalesce(regexp_replace(p.telefone, '\D', '', 'g'), '') <> '')
      and not exists (
        select 1 from public.journey_enrollments e
        where e.journey_id = _journey and e.player_id = d.player_id
          and e.status in ('active', 'waiting', 'paused_by_priority'));
  else
    return query select null::bigint, false;
  end if;
end;
$$;

revoke all on function public.journey_activation_estimate(uuid) from public, anon;
grant execute on function public.journey_activation_estimate(uuid) to authenticated, service_role;
