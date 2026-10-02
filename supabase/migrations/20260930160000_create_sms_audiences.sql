create table if not exists public.sms_audiences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table public.sms_audiences enable row level security;
drop policy if exists "sms audiences tenant access" on public.sms_audiences;
create policy "sms audiences tenant access" on public.sms_audiences for all
using (tenant_id = public.current_tenant_id() or public.is_super_admin())
with check (tenant_id = public.current_tenant_id() or public.is_super_admin());
create index if not exists sms_audiences_tenant_idx on public.sms_audiences(tenant_id, updated_at desc);
