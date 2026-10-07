create table if not exists public.voice_contact_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default true,
  cooldown_hours integer not null default 24 check (cooldown_hours between 0 and 720),
  rolling_24h_limit integer not null default 1 check (rolling_24h_limit between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.voice_contact_policies enable row level security;
create policy voice_contact_policies_tenant_access on public.voice_contact_policies for all to authenticated
using (public.has_tenant_access(tenant_id)) with check (public.has_tenant_access(tenant_id));
grant select, insert, update, delete on public.voice_contact_policies to authenticated;
grant all on public.voice_contact_policies to service_role;
create trigger set_updated_at_voice_contact_policies before update on public.voice_contact_policies
for each row execute function public.set_updated_at();
