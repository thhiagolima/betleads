alter table public.events
  add column if not exists provider_event_id text;

alter table public.sessions
  add column if not exists provider_event_id text;

create unique index if not exists events_tenant_provider_event_uidx
  on public.events (tenant_id, provider_event_id)
  where provider_event_id is not null;

create unique index if not exists sessions_tenant_provider_event_uidx
  on public.sessions (tenant_id, provider_event_id)
  where provider_event_id is not null;
