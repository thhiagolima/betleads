-- P0: provider infrastructure is platform-owned. Tenant administrators are not
-- allowed to bypass the server boundary with direct PostgREST requests.
drop policy if exists "Admins full access email_smtp_configs" on public.email_smtp_configs;
drop policy if exists email_smtp_configs_admin_select on public.email_smtp_configs;
drop policy if exists email_smtp_configs_admin_write on public.email_smtp_configs;
drop policy if exists email_smtp_configs_super_admin_read on public.email_smtp_configs;
drop policy if exists email_smtp_configs_super_admin_write on public.email_smtp_configs;

create policy email_smtp_configs_super_admin_select
  on public.email_smtp_configs for select to authenticated
  using (public.is_super_admin());
create policy email_smtp_configs_super_admin_mutate
  on public.email_smtp_configs for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists "Admins full access email_senders" on public.email_senders;
drop policy if exists email_senders_tenant_select on public.email_senders;
drop policy if exists email_senders_tenant_insert on public.email_senders;
drop policy if exists email_senders_tenant_update on public.email_senders;
drop policy if exists email_senders_tenant_delete on public.email_senders;
drop policy if exists email_senders_super_admin_read on public.email_senders;
drop policy if exists email_senders_super_admin_write on public.email_senders;

create policy email_senders_super_admin_select
  on public.email_senders for select to authenticated
  using (public.is_super_admin());
create policy email_senders_super_admin_mutate
  on public.email_senders for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- P1: one recoverable draft contract for SMS, email and voice.
create table if not exists public.campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email', 'voice')),
  name text not null default '',
  audience_id text,
  audience_criteria jsonb,
  asset_id text,
  asset_kind text,
  asset_snapshot jsonb,
  content text not null default '',
  scheduled_at timestamptz,
  track_links boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  version integer not null default 1,
  idempotency_key uuid not null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index if not exists campaign_drafts_tenant_status_updated_idx
  on public.campaign_drafts (tenant_id, status, updated_at desc);

alter table public.campaign_drafts enable row level security;
grant select, insert, update, delete on public.campaign_drafts to authenticated;
grant all on public.campaign_drafts to service_role;

create policy campaign_drafts_tenant_select on public.campaign_drafts
  for select to authenticated using (public.has_tenant_access(tenant_id));
create policy campaign_drafts_tenant_insert on public.campaign_drafts
  for insert to authenticated
  with check (public.has_tenant_access(tenant_id) and created_by = auth.uid());
create policy campaign_drafts_tenant_update on public.campaign_drafts
  for update to authenticated
  using (public.has_tenant_access(tenant_id) and status = 'draft')
  with check (public.has_tenant_access(tenant_id));
create policy campaign_drafts_tenant_delete on public.campaign_drafts
  for delete to authenticated
  using (public.has_tenant_access(tenant_id) and status = 'draft');

drop trigger if exists trg_campaign_drafts_updated_at on public.campaign_drafts;
create trigger trg_campaign_drafts_updated_at before update on public.campaign_drafts
  for each row execute function public.set_updated_at();
