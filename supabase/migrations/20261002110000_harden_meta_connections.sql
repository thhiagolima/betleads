alter table public.meta_connections
  add column if not exists app_name text,
  add column if not exists connection_label text,
  add column if not exists permissions_checked_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by_user_id uuid;

alter table public.meta_connections
  drop constraint if exists meta_connections_tenant_id_meta_user_id_key;

create unique index if not exists meta_connections_system_identity_key
  on public.meta_connections (
    tenant_id,
    coalesce(app_id, ''),
    coalesce(business_id, ''),
    meta_user_id
  )
  where auth_type = 'system_user_token' and status <> 'disabled';

create table if not exists public.meta_connection_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid references public.meta_connections(id) on delete set null,
  actor_user_id uuid,
  action text not null check (action in (
    'connected',
    'validated',
    'token_replaced',
    'accounts_discovered',
    'accounts_selected',
    'sync_started',
    'sync_succeeded',
    'sync_failed',
    'disabled'
  )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists meta_connection_audit_tenant_created_idx
  on public.meta_connection_audit (tenant_id, created_at desc);

grant all on public.meta_connection_audit to service_role;
alter table public.meta_connection_audit enable row level security;

drop policy if exists meta_connection_audit_service_only on public.meta_connection_audit;
create policy meta_connection_audit_service_only
  on public.meta_connection_audit
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.meta_connection_audit is
  'Server-only audit trail for Meta connection lifecycle. Tokens and secrets must never be stored in metadata.';

comment on column public.meta_connections.app_id is
  'Meta app that issued the system user token.';

comment on column public.meta_connections.business_id is
  'Business Manager represented by this connection. One token can create one connection per business.';
