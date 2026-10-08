alter table public.link_dispatches
  add column if not exists delivery_status text,
  add column if not exists delivered_at timestamptz;

create index if not exists link_dispatches_tenant_delivery_idx
  on public.link_dispatches (tenant_id, source_type, source_id, delivery_status);

create table if not exists public.conversion_report_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_type text not null check (source_type in ('campaign', 'journey')),
  source_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('drilldown_viewed', 'csv_exported')),
  created_at timestamptz not null default now()
);
alter table public.conversion_report_audit_events enable row level security;
grant all on public.conversion_report_audit_events to service_role;
create index if not exists conversion_report_audit_source_idx
  on public.conversion_report_audit_events (tenant_id, source_type, source_id, created_at desc);
