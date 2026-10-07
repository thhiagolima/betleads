-- Keep an immutable, tenant-scoped history for reusable SMS templates.
create or replace function public.bump_sms_template_version()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name
    or new.content is distinct from old.content
    or new.category is distinct from old.category
    or new.tags is distinct from old.tags
    or new.is_active is distinct from old.is_active then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

create table if not exists public.sms_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.sms_templates(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null,
  content text not null,
  category text not null,
  tags text[] not null default '{}'::text[],
  is_active boolean not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

create index if not exists sms_template_versions_tenant_template_idx
  on public.sms_template_versions (tenant_id, template_id, version desc);

alter table public.sms_template_versions enable row level security;

create policy sms_template_versions_tenant_select on public.sms_template_versions
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

grant select on public.sms_template_versions to authenticated;
grant all on public.sms_template_versions to service_role;

create or replace function public.capture_sms_template_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.version is distinct from old.version then
    insert into public.sms_template_versions (
      tenant_id,
      template_id,
      version,
      name,
      content,
      category,
      tags,
      is_active,
      changed_by
    ) values (
      new.tenant_id,
      new.id,
      new.version,
      new.name,
      new.content,
      new.category,
      new.tags,
      new.is_active,
      auth.uid()
    ) on conflict (template_id, version) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_templates_capture_version on public.sms_templates;
create trigger sms_templates_capture_version
  after insert or update on public.sms_templates
  for each row execute function public.capture_sms_template_version();

-- Seed the current state for templates created before this migration.
insert into public.sms_template_versions (
  tenant_id,
  template_id,
  version,
  name,
  content,
  category,
  tags,
  is_active,
  changed_by,
  created_at
)
select
  tenant_id,
  id,
  version,
  name,
  content,
  category,
  tags,
  is_active,
  created_by,
  coalesce(updated_at, created_at)
from public.sms_templates
on conflict (template_id, version) do nothing;
