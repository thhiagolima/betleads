-- Tenant groups (grupos de casas): a house belongs to at most one group
-- (enforced by the unique tenant_id below), a group has managers who get a
-- read-only, group-scoped view that never grants operational tenant access
-- (see docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md, "a
-- função que já existem não podem passar a incluir as casas do grupo").
-- Demo groups may only contain demo houses and demo managers, mirroring the
-- demo-user guards in 20261018100000_demo_tenant_flag.sql.

create table if not exists public.tenant_groups (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid
);

create table if not exists public.tenant_group_tenants (
  group_id uuid not null references public.tenant_groups(id) on delete cascade,
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, tenant_id)
);

create table if not exists public.tenant_group_managers (
  group_id uuid not null references public.tenant_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (group_id, user_id)
);

-- Keeps a group's is_demo in lockstep with its member houses: a demo group
-- may only hold demo houses, a real group only real houses.
create or replace function public.guard_tenant_group_tenants_demo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_is_demo boolean;
  v_tenant_is_demo boolean;
begin
  select is_demo into v_group_is_demo from public.tenant_groups where id = new.group_id;
  select is_demo into v_tenant_is_demo from public.tenants where id = new.tenant_id;

  if v_group_is_demo is distinct from v_tenant_is_demo then
    raise exception 'GROUP_DEMO_MISMATCH: a house''s is_demo must match its group''s is_demo';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_group_tenants_demo on public.tenant_group_tenants;
create trigger trg_tenant_group_tenants_demo
  before insert or update on public.tenant_group_tenants
  for each row
  execute function public.guard_tenant_group_tenants_demo();

-- A group's is_demo is fixed at creation: changing it later would silently
-- strand existing member houses/managers on the wrong side of the demo
-- guards above and below.
create or replace function public.guard_tenant_groups_demo_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.is_demo is distinct from old.is_demo then
    raise exception 'GROUP_DEMO_IMMUTABLE: tenant_groups.is_demo cannot change after creation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_groups_demo_immutable on public.tenant_groups;
create trigger trg_tenant_groups_demo_immutable
  before update of is_demo on public.tenant_groups
  for each row
  when (old.is_demo is distinct from new.is_demo)
  execute function public.guard_tenant_groups_demo_immutable();

-- Mirrors the demo-user confinement in 20261018100000_demo_tenant_flag.sql:
-- a demo user (auth.users.raw_app_meta_data ->> 'is_demo_user' = 'true') may
-- only manage a demo group.
create or replace function public.guard_tenant_group_managers_demo_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_demo_user boolean;
  v_group_is_demo boolean;
begin
  select (raw_app_meta_data ->> 'is_demo_user') = 'true'
  into v_is_demo_user
  from auth.users
  where id = new.user_id;

  select is_demo into v_group_is_demo from public.tenant_groups where id = new.group_id;

  if v_is_demo_user and not v_group_is_demo then
    raise exception 'DEMO_USER_GROUP_VIOLATION: a demo user may only manage a demo group';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tenant_group_managers_demo_user on public.tenant_group_managers;
create trigger trg_tenant_group_managers_demo_user
  before insert or update on public.tenant_group_managers
  for each row
  execute function public.guard_tenant_group_managers_demo_user();

-- Access helpers: all groups for a super admin, otherwise the groups a user
-- actually manages via tenant_group_managers.
create or replace function public.group_ids_managed_by(_user uuid)
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select id from public.tenant_groups where public.is_super_admin(_user)
  union
  select group_id from public.tenant_group_managers
  where user_id = _user and not public.is_super_admin(_user)
$$;

grant execute on function public.group_ids_managed_by(uuid) to authenticated, service_role;

create or replace function public.can_view_group(_user uuid, _group uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_ids_managed_by(_user) as g where g = _group
  )
$$;

grant execute on function public.can_view_group(uuid, uuid) to authenticated, service_role;

-- Only a real group manager counts here: super admin deliberately does not,
-- so this stays a pure, non-escalating membership check for group-scoped
-- financial reads (see spec section 8).
create or replace function public.is_group_manager_of_tenant(_user uuid, _tenant uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_group_managers gm
    join public.tenant_group_tenants gt on gt.group_id = gm.group_id
    where gm.user_id = _user and gt.tenant_id = _tenant
  )
$$;

grant execute on function public.is_group_manager_of_tenant(uuid, uuid) to authenticated, service_role;

create or replace function public.group_tenant_ids(_group uuid)
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select tenant_id from public.tenant_group_tenants where group_id = _group
$$;

grant execute on function public.group_tenant_ids(uuid) to authenticated, service_role;

-- RLS: read-only for authenticated, scoped to groups the caller manages (or
-- all of them for a super admin, via group_ids_managed_by). Only
-- service_role writes; there are no insert/update/delete policies.
alter table public.tenant_groups enable row level security;
alter table public.tenant_group_tenants enable row level security;
alter table public.tenant_group_managers enable row level security;

drop policy if exists tenant_groups_select on public.tenant_groups;
create policy tenant_groups_select
  on public.tenant_groups for select to authenticated
  using (public.can_view_group(auth.uid(), id));

drop policy if exists tenant_group_tenants_select on public.tenant_group_tenants;
create policy tenant_group_tenants_select
  on public.tenant_group_tenants for select to authenticated
  using (public.can_view_group(auth.uid(), group_id));

drop policy if exists tenant_group_managers_select on public.tenant_group_managers;
create policy tenant_group_managers_select
  on public.tenant_group_managers for select to authenticated
  using (public.can_view_group(auth.uid(), group_id));

grant select on public.tenant_groups to authenticated;
grant all on public.tenant_groups to service_role;

grant select on public.tenant_group_tenants to authenticated;
grant all on public.tenant_group_tenants to service_role;

grant select on public.tenant_group_managers to authenticated;
grant all on public.tenant_group_managers to service_role;
