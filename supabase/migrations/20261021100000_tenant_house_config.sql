-- House onboarding/configuration data model: site URL, onboarding status,
-- quick links and custom domains (shortener + email) for a tenant's own
-- house. Credentials for the central Short.io / Infobip accounts stay in
-- server secrets; these tables only hold per-tenant metadata and state.

begin;

alter table public.tenants
  add column if not exists site_url text,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_skipped_at timestamptz;

create table if not exists public.tenant_quick_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,30}$'),
  label text not null,
  path text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists public.tenant_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('shortener', 'email')),
  hostname text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  provider_domain_id text,
  provider_state text,
  dns_records jsonb not null default '[]',
  is_default boolean not null default false,
  last_checked_at timestamptz,
  verified_at timestamptz,
  verified_notice_seen_at timestamptz,
  last_error text,
  removed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A hostname belongs to at most one house, globally, even once removed.
create unique index if not exists tenant_domains_hostname_lower_idx
  on public.tenant_domains (lower(hostname));

-- Only one active default domain per tenant and kind; a removed default does
-- not block a new one from taking its place.
create unique index if not exists tenant_domains_default_per_kind_idx
  on public.tenant_domains (tenant_id, kind)
  where is_default and removed_at is null;

create index if not exists tenant_domains_status_check_idx
  on public.tenant_domains (status, last_checked_at)
  where removed_at is null;

alter table public.email_senders
  add column if not exists domain_id uuid references public.tenant_domains(id);

alter table public.sms_campaigns
  add column if not exists short_domain_id uuid references public.tenant_domains(id) on delete set null;

alter table public.email_campaigns
  add column if not exists sender_id uuid references public.email_senders(id) on delete set null,
  add column if not exists short_domain_id uuid references public.tenant_domains(id) on delete set null,
  -- Why the last send attempt was blocked (e.g. sender's e-mail domain no
  -- longer verified). Shown next to the campaign status; cleared on edit or
  -- on the next send that gets past the sender check.
  add column if not exists blocked_reason text;

alter table public.tenant_quick_links enable row level security;
alter table public.tenant_domains enable row level security;

-- Read: any tenant member (or super admin). Write: service_role only — the
-- server functions validate admin access and write with supabaseAdmin.
drop policy if exists tenant_quick_links_tenant_rls on public.tenant_quick_links;
create policy tenant_quick_links_tenant_rls on public.tenant_quick_links
  as permissive for select to authenticated
  using (
    (select public.is_super_admin())
    or tenant_id = any ((select public.accessible_tenant_ids())::uuid[])
  );

drop policy if exists tenant_domains_tenant_rls on public.tenant_domains;
create policy tenant_domains_tenant_rls on public.tenant_domains
  as permissive for select to authenticated
  using (
    (select public.is_super_admin())
    or tenant_id = any ((select public.accessible_tenant_ids())::uuid[])
  );

grant select on public.tenant_quick_links to authenticated;
grant all on public.tenant_quick_links to service_role;
grant select on public.tenant_domains to authenticated;
grant all on public.tenant_domains to service_role;

create trigger tenant_quick_links_updated_at
  before update on public.tenant_quick_links
  for each row execute function public.set_updated_at();
create trigger tenant_domains_updated_at
  before update on public.tenant_domains
  for each row execute function public.set_updated_at();

-- Backfill: a house that already has a shortener domain configured in
-- shortio_settings gets a verified, default tenant_domains row for it.
-- last_checked_at = now() keeps the verify cron from re-checking every
-- backfilled row at once on its first tick; verified_notice_seen_at = now()
-- keeps existing houses from getting a "domínio verificado" notice for a
-- domain they have been using all along.
insert into public.tenant_domains (
  tenant_id, kind, hostname, status, provider_domain_id, is_default,
  verified_at, last_checked_at, verified_notice_seen_at
)
select
  s.tenant_id,
  'shortener',
  s.domain,
  'verified',
  s.domain_id::text,
  true,
  now(),
  now(),
  now()
from public.shortio_settings s
where s.domain is not null
on conflict do nothing;

-- Existing houses never see the onboarding wizard.
update public.tenants
set onboarding_completed_at = now()
where onboarding_completed_at is null;

commit;

notify pgrst, 'reload schema';
