-- Per-house financial close: daily manual entries (ad spend, GGR), free-form
-- monthly "other costs", a GGR/movement fee-rate history per house, explicit
-- per-person viewer grants for gestores, and a per-metric daily-goal history
-- per house (see docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md,
-- sections 5 and 7). Values are historized with valid_from so a rate/goal
-- change never rewrites the past (section 10, "o passado não é recalculado").

create table if not exists public.tenant_finance_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric_date date not null,
  ad_spend numeric(14,2) check (ad_spend >= 0),
  ggr numeric(14,2),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric_date)
);

comment on table public.tenant_finance_daily is
  'Manual daily entries for a house''s financial close. null means "not entered yet" (section 5, "Dias pendentes").';

create table if not exists public.tenant_finance_other_costs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  descricao text not null,
  valor numeric(14,2) not null check (valor >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_finance_other_costs_tenant_month_idx
  on public.tenant_finance_other_costs (tenant_id, month);

create table if not exists public.tenant_finance_rates (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  valid_from date not null,
  ggr_fee_pct numeric(6,3) not null check (ggr_fee_pct between 0 and 100),
  movement_fee_pct numeric(6,3) not null check (movement_fee_pct between 0 and 100),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, valid_from)
);

create table if not exists public.tenant_finance_viewers (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists public.tenant_goals (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric text not null check (metric in (
    'registrations', 'ftds', 'deposits', 'net', 'cash_result',
    'cost_per_registration', 'cost_per_ftd', 'roi'
  )),
  valid_from date not null,
  direction text not null check (direction in ('gte', 'lte')),
  daily_value numeric(14,4),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric, valid_from)
);

comment on column public.tenant_goals.daily_value is
  'null means the goal was removed from valid_from onward (design doc section 7).';

-- ============================================================
-- Permission helpers: (_user uuid, _tenant uuid) -> boolean, matching the
-- access matrix in sections 3 and 5 of the design doc.
-- ============================================================

create or replace function public.finance_can_view(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select
    public.is_super_admin(_user)
    or exists (
      select 1 from public.user_roles
      where user_id = _user and tenant_id = _tenant and role = 'admin'
    )
    or public.is_group_manager_of_tenant(_user, _tenant)
    or (
      exists (
        select 1 from public.user_roles
        where user_id = _user and tenant_id = _tenant and role = 'gestor'
      )
      and exists (
        select 1 from public.tenant_finance_viewers
        where tenant_id = _tenant and user_id = _user
      )
    )
$$;

revoke all on function public.finance_can_view(uuid, uuid) from public, anon;
grant execute on function public.finance_can_view(uuid, uuid) to authenticated, service_role;

create or replace function public.finance_can_edit_values(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select
    public.is_super_admin(_user)
    or exists (
      select 1 from public.user_roles
      where user_id = _user and tenant_id = _tenant and role = 'admin'
    )
$$;

revoke all on function public.finance_can_edit_values(uuid, uuid) from public, anon;
grant execute on function public.finance_can_edit_values(uuid, uuid) to authenticated, service_role;

create or replace function public.finance_can_edit_rates(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select
    public.is_super_admin(_user)
    or exists (
      select 1 from public.user_roles
      where user_id = _user and tenant_id = _tenant and role = 'admin'
    )
    or public.is_group_manager_of_tenant(_user, _tenant)
$$;

revoke all on function public.finance_can_edit_rates(uuid, uuid) from public, anon;
grant execute on function public.finance_can_edit_rates(uuid, uuid) to authenticated, service_role;

-- Same rule as finance_can_edit_rates (per the design doc's access matrix:
-- liberar o financeiro segue a mesma linha de "alterar as taxas").
create or replace function public.finance_can_manage_viewers(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select public.finance_can_edit_rates(_user, _tenant)
$$;

revoke all on function public.finance_can_manage_viewers(uuid, uuid) from public, anon;
grant execute on function public.finance_can_manage_viewers(uuid, uuid) to authenticated, service_role;

create or replace function public.finance_can_manage_goals(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select
    public.is_super_admin(_user)
    or public.is_group_manager_of_tenant(_user, _tenant)
$$;

revoke all on function public.finance_can_manage_goals(uuid, uuid) from public, anon;
grant execute on function public.finance_can_manage_goals(uuid, uuid) to authenticated, service_role;

-- ============================================================
-- RLS: read via finance_can_view; writes only through service_role (no
-- insert/update/delete policy for authenticated).
-- ============================================================

alter table public.tenant_finance_daily enable row level security;
alter table public.tenant_finance_other_costs enable row level security;
alter table public.tenant_finance_rates enable row level security;
alter table public.tenant_finance_viewers enable row level security;
alter table public.tenant_goals enable row level security;

drop policy if exists tenant_finance_daily_select on public.tenant_finance_daily;
create policy tenant_finance_daily_select
  on public.tenant_finance_daily for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

drop policy if exists tenant_finance_other_costs_select on public.tenant_finance_other_costs;
create policy tenant_finance_other_costs_select
  on public.tenant_finance_other_costs for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

drop policy if exists tenant_finance_rates_select on public.tenant_finance_rates;
create policy tenant_finance_rates_select
  on public.tenant_finance_rates for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

drop policy if exists tenant_finance_viewers_select on public.tenant_finance_viewers;
create policy tenant_finance_viewers_select
  on public.tenant_finance_viewers for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

drop policy if exists tenant_goals_select on public.tenant_goals;
create policy tenant_goals_select
  on public.tenant_goals for select to authenticated
  using (public.finance_can_view(auth.uid(), tenant_id));

grant select on public.tenant_finance_daily to authenticated;
grant all on public.tenant_finance_daily to service_role;

grant select on public.tenant_finance_other_costs to authenticated;
grant all on public.tenant_finance_other_costs to service_role;

grant select on public.tenant_finance_rates to authenticated;
grant all on public.tenant_finance_rates to service_role;

grant select on public.tenant_finance_viewers to authenticated;
grant all on public.tenant_finance_viewers to service_role;

grant select on public.tenant_goals to authenticated;
grant all on public.tenant_goals to service_role;

-- ============================================================
-- Day-shaped data for the financial close (section 5) and group goal
-- scoreboard (section 7). service_role only: these synthesize one row per
-- tenant x day over an arbitrary tenant set and must not be reachable
-- through RLS directly (callers filter the tenant set themselves, the same
-- way group_tenant_ids() is used elsewhere).
-- ============================================================

create or replace function public.finance_days(_tenants uuid[], _from date, _to date)
returns table (
  tenant_id uuid,
  metric_date date,
  registrations int,
  ftds int,
  ftd_deposit_amount numeric,
  deposit_amount numeric,
  withdrawal_amount numeric,
  ad_spend numeric,
  ad_spend_suggested numeric,
  ggr numeric,
  ggr_fee_pct numeric,
  movement_fee_pct numeric
)
language sql
stable security definer
set search_path = public
as $$
  with days as (
    select t.id as tenant_id, d::date as metric_date
    from unnest(_tenants) as t(id)
    cross join generate_series(_from::timestamp, _to::timestamp, interval '1 day') as d
  ),
  ftd_sums as (
    -- One row per house x FTD day: the first approved deposit of every
    -- player whose ftd_em (Brasília day) falls on that day, summed. Scoped
    -- to the requested tenants and [_from, _to] window (in Brasília time)
    -- so this never aggregates over the whole players table.
    select
      p.tenant_id,
      (p.ftd_em at time zone 'America/Sao_Paulo')::date as metric_date,
      sum(dep.valor) as ftd_deposit_amount
    from public.players p
    join lateral (
      -- d.tenant_id = p.tenant_id lets this use the existing
      -- deposits_tenant_player_status_idx (tenant_id, player_id, status)
      -- instead of a player_id-only lookup.
      select d.valor
      from public.deposits d
      where d.tenant_id = p.tenant_id and d.player_id = p.id and d.status = 'aprovado'
      order by coalesce(d.completed_at, d.created_at)
      limit 1
    ) dep on true
    where p.tenant_id = any(_tenants)
      and p.ftd_em >= (_from::timestamp at time zone 'America/Sao_Paulo')
      and p.ftd_em < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by p.tenant_id, (p.ftd_em at time zone 'America/Sao_Paulo')::date
  ),
  ad_suggested as (
    select tenant_id, metric_date, sum(spend) as ad_spend_suggested
    from public.marketing_ad_metrics_daily
    where provider = 'meta'
      and tenant_id = any(_tenants)
      and metric_date between _from and _to
    group by tenant_id, metric_date
  ),
  day_rates as (
    -- The rate row with the greatest valid_from <= the day, else the
    -- spreadsheet's historical default (16% GGR, 2.7% movement).
    select
      days.tenant_id,
      days.metric_date,
      coalesce(r.ggr_fee_pct, 16) as ggr_fee_pct,
      coalesce(r.movement_fee_pct, 2.7) as movement_fee_pct
    from days
    left join lateral (
      select fr.ggr_fee_pct, fr.movement_fee_pct
      from public.tenant_finance_rates fr
      where fr.tenant_id = days.tenant_id and fr.valid_from <= days.metric_date
      order by fr.valid_from desc
      limit 1
    ) r on true
  )
  select
    days.tenant_id,
    days.metric_date,
    coalesce(m.registrations, 0),
    coalesce(m.ftds, 0),
    coalesce(f.ftd_deposit_amount, 0),
    coalesce(m.approved_deposit_amount, 0),
    coalesce(m.approved_withdrawal_amount, 0),
    fd.ad_spend,
    a.ad_spend_suggested,
    fd.ggr,
    day_rates.ggr_fee_pct,
    day_rates.movement_fee_pct
  from days
  left join public.tenant_daily_metrics m
    on m.tenant_id = days.tenant_id and m.metric_date = days.metric_date
  left join ftd_sums f
    on f.tenant_id = days.tenant_id and f.metric_date = days.metric_date
  left join ad_suggested a
    on a.tenant_id = days.tenant_id and a.metric_date = days.metric_date
  left join public.tenant_finance_daily fd
    on fd.tenant_id = days.tenant_id and fd.metric_date = days.metric_date
  left join day_rates
    on day_rates.tenant_id = days.tenant_id and day_rates.metric_date = days.metric_date
  order by days.tenant_id, days.metric_date
$$;

revoke all on function public.finance_days(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_days(uuid[], date, date) to service_role;

create or replace function public.finance_goal_days(_tenants uuid[], _from date, _to date)
returns table (
  tenant_id uuid,
  metric_date date,
  metric text,
  direction text,
  daily_value numeric
)
language sql
stable security definer
set search_path = public
as $$
  with days as (
    select t.id as tenant_id, d::date as metric_date
    from unnest(_tenants) as t(id)
    cross join generate_series(_from::timestamp, _to::timestamp, interval '1 day') as d
  ),
  metrics (metric) as (
    values
      ('registrations'), ('ftds'), ('deposits'), ('net'), ('cash_result'),
      ('cost_per_registration'), ('cost_per_ftd'), ('roi')
  )
  select days.tenant_id, days.metric_date, metrics.metric, g.direction, g.daily_value
  from days
  cross join metrics
  join lateral (
    -- The goal row with the greatest valid_from <= the day. A join lateral
    -- (not left join) already omits tenant x day x metric combos with no
    -- row at all; the where clause below additionally omits a removed goal
    -- (daily_value is null).
    select tg.direction, tg.daily_value
    from public.tenant_goals tg
    where tg.tenant_id = days.tenant_id
      and tg.metric = metrics.metric
      and tg.valid_from <= days.metric_date
    order by tg.valid_from desc
    limit 1
  ) g on true
  where g.daily_value is not null
$$;

revoke all on function public.finance_goal_days(uuid[], date, date) from public, anon, authenticated;
grant execute on function public.finance_goal_days(uuid[], date, date) to service_role;

-- No new index is added here: deposits_tenant_player_status_idx
-- (tenant_id, player_id, status), created by
-- 20261002173000_batch_daily_metric_refresh.sql, already covers the
-- ftd_sums lateral above now that it filters on d.tenant_id = p.tenant_id
-- too. A dedicated player_id-led index was considered (and confirmed
-- absent via a read-only prod check on 2026-10-24) but was deliberately
-- left out to avoid a write-locking index build on production's deposits
-- table.
