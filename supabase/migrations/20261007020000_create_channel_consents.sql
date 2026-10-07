create table if not exists public.channel_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel text not null check (channel in ('sms','email','voice')),
  subject text not null,
  status text not null check (status in ('granted','revoked')),
  legal_basis text,
  reason text not null default 'manual',
  source text not null default 'operator',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel, subject)
);
create index if not exists channel_consents_lookup_idx on public.channel_consents (tenant_id, channel, subject, status);
alter table public.channel_consents enable row level security;
create policy channel_consents_tenant_access on public.channel_consents for all to authenticated
using (public.has_tenant_access(tenant_id)) with check (public.has_tenant_access(tenant_id));
grant select, insert, update, delete on public.channel_consents to authenticated;
grant all on public.channel_consents to service_role;
create trigger set_updated_at_channel_consents before update on public.channel_consents for each row execute function public.set_updated_at();

create table if not exists public.channel_consent_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  consent_id uuid references public.channel_consents(id) on delete set null,
  channel text not null,
  subject text not null,
  previous_status text,
  new_status text not null,
  reason text,
  source text,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists channel_consent_audit_tenant_idx on public.channel_consent_audit (tenant_id, created_at desc);
alter table public.channel_consent_audit enable row level security;
create policy channel_consent_audit_tenant_read on public.channel_consent_audit for select to authenticated using (public.has_tenant_access(tenant_id));
grant select on public.channel_consent_audit to authenticated;
grant all on public.channel_consent_audit to service_role;

insert into public.channel_consents (tenant_id, channel, subject, status, reason, source, occurred_at)
select tenant_id, 'sms', regexp_replace(phone, '\D', '', 'g'), 'revoked', reason, 'legacy_sms', created_at
from public.sms_suppressions where tenant_id is not null
on conflict (tenant_id, channel, subject) do update set status='revoked', reason=excluded.reason, source=excluded.source;

insert into public.channel_consents (tenant_id, channel, subject, status, reason, source, occurred_at)
select tenant_id, 'email', lower(trim(email)), 'revoked', reason, 'legacy_email', created_at
from public.suppressed_emails where tenant_id is not null
on conflict (tenant_id, channel, subject) do update set status='revoked', reason=excluded.reason, source=excluded.source;
