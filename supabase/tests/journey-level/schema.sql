-- Minimal schema for src/lib/journey-level-transition.db.test.ts (PGlite).
--
-- Only the columns, types, constraints and foreign keys touched by
-- public.journey_level_for_total() and public.transition_journey_level_on_deposit()
-- are reproduced, copied from:
--   20260922163000_create_gamification_settings.sql (gamification_settings)
--   20261005120000_create_multichannel_journeys.sql (journeys, journey_enrollments, journey_events)
--   20261008230000_add_journey_conflict_model.sql   (conflict_family, journey_priority, paused_by_priority)
-- Supabase roles are stubbed so the migrations' REVOKE/GRANT statements run unchanged.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.tenants (
  id uuid primary key default gen_random_uuid()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  total_depositado numeric default 0
);

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  status text not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.gamification_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  level_thresholds jsonb not null default '{"bronze":10,"silver":200,"gold":500,"diamond":1000,"black":3000}'::jsonb
);

create type public.journey_status as enum ('draft', 'active', 'paused', 'archived');
create type public.journey_enrollment_status as enum (
  'active', 'waiting', 'paused', 'completed', 'exited', 'failed', 'paused_by_priority'
);

create table public.journeys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  status public.journey_status not null default 'draft',
  trigger_type text not null default 'manual',
  trigger_config jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  conflict_family text,
  journey_priority integer not null default 4 check (journey_priority between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  journey_version integer not null check (journey_version > 0),
  player_id uuid references public.players(id) on delete set null,
  entry_key text not null default 'default' check (char_length(entry_key) <= 160),
  status public.journey_enrollment_status not null default 'active',
  exited_at timestamptz,
  exit_reason text,
  claimed_at timestamptz,
  claimed_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, player_id, entry_key)
);

create table public.journey_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  enrollment_id uuid references public.journey_enrollments(id) on delete set null,
  event_type text not null check (char_length(event_type) <= 100),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
