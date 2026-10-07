-- Immutable histories for reusable e-mail and voice templates.

alter table public.email_flow_blocks
  add column if not exists track_links boolean not null default true;

create or replace function public.bump_email_template_version()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name
    or new.subject is distinct from old.subject
    or new.preheader is distinct from old.preheader
    or new.body_html is distinct from old.body_html
    or new.body_text is distinct from old.body_text
    or new.from_name is distinct from old.from_name
    or new.tags is distinct from old.tags
    or new.track_links is distinct from old.track_links
    or new.lifecycle_status is distinct from old.lifecycle_status then
    new.version := old.version + 1;
  end if;
  if new.lifecycle_status = 'published' and old.lifecycle_status is distinct from 'published' then
    new.published_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.bump_call_script_version()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name
    or new.content is distinct from old.content
    or new.status is distinct from old.status
    or new.default_voice_id is distinct from old.default_voice_id
    or new.voice_settings is distinct from old.voice_settings then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

create table if not exists public.email_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.email_templates(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null,
  subject text not null,
  preheader text,
  from_name text,
  body_html text not null,
  body_text text not null default '',
  tags text[] not null default '{}'::text[],
  track_links boolean not null default true,
  lifecycle_status text not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

create index if not exists email_template_versions_tenant_template_idx
  on public.email_template_versions (tenant_id, template_id, version desc);

alter table public.email_template_versions enable row level security;

create policy email_template_versions_tenant_select on public.email_template_versions
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

grant select on public.email_template_versions to authenticated;
grant all on public.email_template_versions to service_role;

create or replace function public.capture_email_template_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.email_template_versions (
      tenant_id, template_id, version, name, subject, preheader, from_name,
      body_html, body_text, tags, track_links, lifecycle_status, changed_by
    ) values (
      new.tenant_id, new.id, new.version, new.name, new.subject, new.preheader, new.from_name,
      new.body_html, new.body_text, new.tags, new.track_links, new.lifecycle_status, auth.uid()
    ) on conflict (template_id, version) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists email_templates_capture_version on public.email_templates;
create trigger email_templates_capture_version
  after insert or update on public.email_templates
  for each row execute function public.capture_email_template_version();

insert into public.email_template_versions (
  tenant_id, template_id, version, name, subject, preheader, from_name,
  body_html, body_text, tags, track_links, lifecycle_status, created_at
)
select
  tenant_id, id, version, name, subject, preheader, from_name,
  body_html, body_text, tags, track_links, lifecycle_status, coalesce(updated_at, created_at)
from public.email_templates
on conflict (template_id, version) do nothing;

create table if not exists public.call_script_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  script_id uuid not null references public.call_scripts(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null,
  content text not null,
  status public.call_script_status not null,
  default_voice_id text,
  voice_settings jsonb not null default '{}'::jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (script_id, version)
);

create index if not exists call_script_versions_tenant_script_idx
  on public.call_script_versions (tenant_id, script_id, version desc);

alter table public.call_script_versions enable row level security;

create policy call_script_versions_tenant_select on public.call_script_versions
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

grant select on public.call_script_versions to authenticated;
grant all on public.call_script_versions to service_role;

create or replace function public.capture_call_script_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.call_script_versions (
      tenant_id, script_id, version, name, content, status,
      default_voice_id, voice_settings, changed_by
    ) values (
      new.tenant_id, new.id, new.version, new.name, new.content, new.status,
      new.default_voice_id, new.voice_settings, auth.uid()
    ) on conflict (script_id, version) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists call_scripts_capture_version on public.call_scripts;
create trigger call_scripts_capture_version
  after insert or update on public.call_scripts
  for each row execute function public.capture_call_script_version();

insert into public.call_script_versions (
  tenant_id, script_id, version, name, content, status,
  default_voice_id, voice_settings, created_at
)
select
  tenant_id, id, version, name, content, status,
  default_voice_id, voice_settings, coalesce(updated_at, created_at)
from public.call_scripts
on conflict (script_id, version) do nothing;

-- Record archive time so retention can be enforced and audited independently of updated_at.
alter table public.journey_voice_assets
  add column if not exists archived_at timestamptz;

create or replace function public.set_voice_asset_archived_at()
returns trigger language plpgsql as $$
begin
  if new.is_archived and not old.is_archived then
    new.archived_at := now();
  elsif not new.is_archived then
    new.archived_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists journey_voice_assets_set_archived_at on public.journey_voice_assets;
create trigger journey_voice_assets_set_archived_at
  before update of is_archived on public.journey_voice_assets
  for each row execute function public.set_voice_asset_archived_at();
