create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 160),
  content text not null check (char_length(content) between 1 and 480),
  category text not null default 'Geral' check (char_length(trim(category)) between 1 and 80),
  tags text[] not null default '{}'::text[],
  is_active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_templates_tenant_active_idx
  on public.sms_templates (tenant_id, is_active, updated_at desc);

alter table public.sms_templates enable row level security;

create policy "sms templates tenant access" on public.sms_templates
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

grant select, insert, update, delete on public.sms_templates to authenticated;
grant all on public.sms_templates to service_role;

drop trigger if exists sms_templates_set_updated_at on public.sms_templates;
create trigger sms_templates_set_updated_at
  before update on public.sms_templates
  for each row execute function public.set_updated_at();

create or replace function public.bump_sms_template_version()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name
    or new.content is distinct from old.content
    or new.category is distinct from old.category
    or new.tags is distinct from old.tags then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_templates_bump_version on public.sms_templates;
create trigger sms_templates_bump_version
  before update on public.sms_templates
  for each row execute function public.bump_sms_template_version();

alter table public.sms_campaigns
  add column if not exists template_id uuid references public.sms_templates(id) on delete set null,
  add column if not exists template_snapshot jsonb;

alter table public.sms_flow_steps
  add column if not exists template_id uuid references public.sms_templates(id) on delete set null,
  add column if not exists template_snapshot jsonb;
