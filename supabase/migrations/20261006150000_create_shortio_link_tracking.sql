-- Short.io link tracking foundation. API credentials stay in server secrets;
-- this schema intentionally stores only tenant-level behaviour and metadata.

begin;

create table if not exists public.shortio_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  domain text,
  domain_id bigint,
  attribution_mode text not null default 'individual'
    check (attribution_mode in ('individual', 'aggregate')),
  fallback_mode text not null default 'block'
    check (fallback_mode in ('block', 'passthrough')),
  default_ttl_days integer
    check (default_ttl_days is null or default_ttl_days between 1 and 3650),
  allowed_destination_hosts text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shortio_link_id text not null,
  short_url text not null,
  original_url text not null,
  canonical_url_hash text not null,
  path text,
  status text not null default 'active'
    check (status in ('active', 'archived', 'expired', 'failed')),
  expires_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, shortio_link_id),
  unique (tenant_id, canonical_url_hash)
);

create index if not exists tracked_links_tenant_created_idx
  on public.tracked_links (tenant_id, created_at desc);
create index if not exists tracked_links_tenant_status_idx
  on public.tracked_links (tenant_id, status, last_synced_at nulls first);

create table if not exists public.link_dispatches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracked_link_id uuid not null references public.tracked_links(id) on delete restrict,
  tracking_token uuid not null default gen_random_uuid(),
  channel text not null check (channel in ('sms', 'whatsapp', 'email')),
  recipient_player_id uuid references public.players(id) on delete set null,
  recipient_hash text,
  source_type text not null,
  source_id text,
  message_log_type text,
  message_log_id text,
  url_position integer not null default 0 check (url_position >= 0),
  original_url text not null,
  sent_url text not null,
  send_status text not null default 'prepared'
    check (send_status in ('prepared', 'sent', 'failed', 'skipped')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, tracking_token)
);

create index if not exists link_dispatches_tenant_created_idx
  on public.link_dispatches (tenant_id, created_at desc);
create index if not exists link_dispatches_tenant_player_idx
  on public.link_dispatches (tenant_id, recipient_player_id, sent_at desc)
  where recipient_player_id is not null;
create index if not exists link_dispatches_tenant_source_idx
  on public.link_dispatches (tenant_id, channel, source_type, source_id, sent_at desc);

create table if not exists public.link_click_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tracked_link_id uuid not null references public.tracked_links(id) on delete cascade,
  snapshot_at timestamptz not null,
  clicks integer not null default 0 check (clicks >= 0),
  human_clicks integer check (human_clicks is null or human_clicks >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tracked_link_id, snapshot_at)
);

create index if not exists link_click_snapshots_tenant_link_time_idx
  on public.link_click_snapshots (tenant_id, tracked_link_id, snapshot_at desc);

create table if not exists public.link_tracking_sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  cursor text,
  links_processed integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists link_tracking_sync_runs_tenant_started_idx
  on public.link_tracking_sync_runs (tenant_id, started_at desc);

-- The app already applies these policies to tenant tables defensively, but
-- explicit policies make this migration safe on a fresh database as well.
alter table public.shortio_settings enable row level security;
alter table public.tracked_links enable row level security;
alter table public.link_dispatches enable row level security;
alter table public.link_click_snapshots enable row level security;
alter table public.link_tracking_sync_runs enable row level security;

do $$
declare
  target text;
begin
  foreach target in array array[
    'shortio_settings', 'tracked_links', 'link_dispatches',
    'link_click_snapshots', 'link_tracking_sync_runs'
  ] loop
    execute format(
      'create policy tenant_access_base on public.%I as permissive for all to authenticated using (public.has_tenant_access(tenant_id)) with check (public.has_tenant_access(tenant_id))',
      target
    );
    execute format(
      'create policy tenant_isolation_guard on public.%I as restrictive for all to authenticated using (public.has_tenant_access(tenant_id)) with check (public.has_tenant_access(tenant_id))',
      target
    );
  end loop;
end
$$;

create trigger shortio_settings_updated_at
  before update on public.shortio_settings
  for each row execute function public.set_updated_at();
create trigger tracked_links_updated_at
  before update on public.tracked_links
  for each row execute function public.set_updated_at();
create trigger link_dispatches_updated_at
  before update on public.link_dispatches
  for each row execute function public.set_updated_at();

commit;
