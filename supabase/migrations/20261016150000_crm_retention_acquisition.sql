-- Central de Resultados F4: retention cohorts, acquisition funnel and the
-- current lifecycle snapshot (docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md 7.5/7.6).
--
-- Our deposit history starts on 2026-09-02, so cohorts are weekly. A player's
-- first approved deposit in our history only counts as an FTD when it is the
-- real first deposit (players.ftd_em absent or within 10 minutes of it), so
-- older depositors are not mistaken for new ones. A rate is only returned once
-- its window has closed for the whole cohort.

create or replace function public.crm_retention_cohorts(_tenant uuid, _weeks integer default 12)
returns table (
  cohort_week date,
  cohort_size bigint,
  second_7d_pct numeric,
  second_14d_pct numeric,
  second_30d_pct numeric,
  median_hours_to_second numeric,
  revenue_30d numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with guard as (
    select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
  ),
  dep as (
    select d.player_id, d.created_at, d.valor,
           row_number() over (partition by d.player_id order by d.created_at, d.id) n
    from public.deposits d, guard
    where guard.ok and d.tenant_id = _tenant and d.status = 'aprovado' and d.player_id is not null
  ),
  firsts as (
    select dep.player_id, dep.created_at ftd_at
    from dep
    join public.players p on p.id = dep.player_id
    where dep.n = 1
      and (p.ftd_em is null or p.ftd_em >= dep.created_at - interval '10 minutes')
      and dep.created_at >= date_trunc('week', now() at time zone 'America/Sao_Paulo')
                             at time zone 'America/Sao_Paulo'
                             - make_interval(weeks => greatest(1, _weeks))
  ),
  seconds as (
    select player_id, created_at second_at from dep where n = 2
  ),
  revenue as (
    select f.player_id, sum(x.valor) revenue_30d
    from firsts f
    join dep x on x.player_id = f.player_id and x.created_at <= f.ftd_at + interval '30 days'
    group by f.player_id
  ),
  cohort as (
    select (date_trunc('week', f.ftd_at at time zone 'America/Sao_Paulo'))::date cohort_week,
           f.player_id, f.ftd_at, s.second_at, coalesce(r.revenue_30d, 0) revenue_30d
    from firsts f
    left join seconds s on s.player_id = f.player_id
    left join revenue r on r.player_id = f.player_id
  )
  select cohort_week,
         count(*),
         round(100.0 * count(*) filter (where second_at <= ftd_at + interval '7 days') / count(*), 1),
         case when max(ftd_at) <= now() - interval '14 days' then
           round(100.0 * count(*) filter (where second_at <= ftd_at + interval '14 days') / count(*), 1) end,
         case when max(ftd_at) <= now() - interval '30 days' then
           round(100.0 * count(*) filter (where second_at <= ftd_at + interval '30 days') / count(*), 1) end,
         round((percentile_cont(0.5) within group (
           order by extract(epoch from second_at - ftd_at) / 3600))::numeric, 1),
         case when max(ftd_at) <= now() - interval '30 days' then sum(revenue_30d) end
  from cohort
  group by cohort_week
  order by cohort_week;
$$;

-- Sign-ups of the period and how far each got (never above 100% of sign-ups).
-- One row per origin (utm_source, "(sem origem)" when empty) plus a "__total__" row.
create or replace function public.crm_acquisition_funnel(_tenant uuid, _from timestamptz, _to timestamptz)
returns table (
  origin text,
  signups bigint,
  first_deposit bigint,
  second_deposit bigint,
  third_plus bigint,
  median_hours_to_ftd numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with guard as (
    select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
  ),
  signups as (
    select p.id, p.created_at,
           coalesce(nullif(trim(p.utm_source), ''), '(sem origem)') origin
    from public.players p, guard
    where guard.ok and p.tenant_id = _tenant and p.created_at between _from and _to
  ),
  deps as (
    select d.player_id, count(*) n, min(d.created_at) first_at
    from public.deposits d
    where d.tenant_id = _tenant and d.status = 'aprovado'
      and d.player_id in (select id from signups)
    group by d.player_id
  ),
  joined as (
    select s.origin, coalesce(d.n, 0) n,
           case when d.first_at is not null then extract(epoch from d.first_at - s.created_at) / 3600 end h
    from signups s left join deps d on d.player_id = s.id
  )
  select origin, count(*), count(*) filter (where n >= 1), count(*) filter (where n >= 2),
         count(*) filter (where n >= 3),
         round((percentile_cont(0.5) within group (order by h))::numeric, 1)
  from joined group by origin
  union all
  select '__total__', count(*), count(*) filter (where n >= 1), count(*) filter (where n >= 2),
         count(*) filter (where n >= 3),
         round((percentile_cont(0.5) within group (order by h))::numeric, 1)
  from joined;
$$;

-- Where the base is right now, by days since the last deposit.
create or replace function public.crm_lifecycle_snapshot(_tenant uuid)
returns table (state text, players bigint)
language sql
stable
security definer
set search_path = public
as $$
  select case
           when p.ultimo_deposito is null and p.ftd_em is null then 'sem_ftd'
           when p.ultimo_deposito is null then 'sem_historico'
           when p.ultimo_deposito >= now() - interval '48 hours' then 'ativo'
           when p.ultimo_deposito >= now() - interval '7 days' then 'esfriando'
           when p.ultimo_deposito >= now() - interval '30 days' then 'dormindo'
           else 'perdido'
         end,
         count(*)
  from public.players p
  where p.tenant_id = _tenant
    and (public.has_tenant_access(_tenant) or auth.role() = 'service_role')
  group by 1;
$$;

revoke all on function public.crm_retention_cohorts(uuid, integer) from public, anon;
grant execute on function public.crm_retention_cohorts(uuid, integer) to authenticated, service_role;
revoke all on function public.crm_acquisition_funnel(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_acquisition_funnel(uuid, timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.crm_lifecycle_snapshot(uuid) from public, anon;
grant execute on function public.crm_lifecycle_snapshot(uuid) to authenticated, service_role;
