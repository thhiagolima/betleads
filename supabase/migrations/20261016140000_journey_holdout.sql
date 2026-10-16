-- Central de Resultados F3: holdout (control group) per journey
-- (docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md, section 5.3, R-04).
--
-- journeys.holdout_percent (0 = off, default) puts that share of the players
-- entering the journey in a control group. The draw is deterministic per
-- (journey, player), made at entry, never chosen by the operator. Control
-- players go through the journey (waits, exits, loops) but no message is sent
-- or charged; the dispatcher skips their send steps (provider 'holdout').
-- journey_holdout_results() compares the 7-day return of both groups for
-- entries whose window has closed.

alter table public.journeys
  add column if not exists holdout_percent integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'journeys_holdout_percent_check'
  ) then
    alter table public.journeys
      add constraint journeys_holdout_percent_check check (holdout_percent between 0 and 50);
  end if;
end $$;

alter table public.journey_enrollments
  add column if not exists is_holdout boolean not null default false;

create index if not exists journey_enrollments_holdout_idx
  on public.journey_enrollments (tenant_id, journey_id, entered_at)
  where is_holdout;

create or replace function public.assign_journey_holdout()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_percent integer;
begin
  if new.player_id is null then
    return new;
  end if;
  select holdout_percent into v_percent from public.journeys where id = new.journey_id;
  if coalesce(v_percent, 0) > 0 then
    -- Stable bucket 0..99 per (journey, player): the same player stays in the
    -- same group on every re-entry of this journey.
    new.is_holdout := mod(
      abs(hashtextextended(new.journey_id::text || ':' || new.player_id::text, 0)), 100
    ) < v_percent;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_journey_holdout_assignment on public.journey_enrollments;
create trigger trg_journey_holdout_assignment
before insert on public.journey_enrollments
for each row execute function public.assign_journey_holdout();

-- ---------------------------------------------------------------------------
-- Treated x control, per journey, for entries whose return window closed.
-- ---------------------------------------------------------------------------
create or replace function public.journey_holdout_results(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz,
  _window_days integer default 7
)
returns table (
  journey_id uuid,
  is_holdout boolean,
  players bigint,
  returned bigint,
  revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with guard as (
    select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
  ),
  holdout_journeys as (
    select distinct e.journey_id
    from public.journey_enrollments e, guard
    where guard.ok and e.tenant_id = _tenant and e.is_holdout
      and e.entered_at between _from and _to
  ),
  -- First entry of each player in each journey within the period.
  entries as (
    select distinct on (e.journey_id, e.player_id)
           e.journey_id, e.player_id, e.is_holdout, e.entered_at
    from public.journey_enrollments e
    where e.tenant_id = _tenant
      and e.journey_id in (select journey_id from holdout_journeys)
      and e.player_id is not null
      and e.entered_at between _from and least(_to, now() - make_interval(days => _window_days))
    order by e.journey_id, e.player_id, e.entered_at
  )
  select en.journey_id, en.is_holdout,
         count(*) players,
         count(*) filter (where r.revenue is not null) returned,
         coalesce(sum(r.revenue), 0) revenue
  from entries en
  left join lateral (
    select sum(d.valor) revenue
    from public.deposits d
    where d.tenant_id = _tenant and d.player_id = en.player_id
      and d.status = 'aprovado'
      and d.created_at > en.entered_at
      and d.created_at <= en.entered_at + make_interval(days => _window_days)
    having count(*) > 0
  ) r on true
  group by en.journey_id, en.is_holdout;
$$;

revoke all on function public.journey_holdout_results(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.journey_holdout_results(uuid, timestamptz, timestamptz, integer) to authenticated, service_role;
