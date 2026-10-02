-- Permite ON CONFLICT explícito no PostgREST e elimina erros 23505 de entregas repetidas.
drop index if exists public.events_tenant_provider_event_uidx;
alter table public.events
  drop constraint if exists events_tenant_provider_event_uidx;
alter table public.events
  add constraint events_tenant_provider_event_uidx unique (tenant_id, provider_event_id);

drop index if exists public.sessions_tenant_provider_event_uidx;
alter table public.sessions
  drop constraint if exists sessions_tenant_provider_event_uidx;
alter table public.sessions
  add constraint sessions_tenant_provider_event_uidx unique (tenant_id, provider_event_id);

create table if not exists public.webhook_event_receipts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_event_id text not null,
  event_name text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  attempt_count integer not null default 1,
  locked_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider_event_id)
);

create index if not exists webhook_event_receipts_status_idx
  on public.webhook_event_receipts (status, locked_at);

alter table public.webhook_event_receipts enable row level security;
grant all on public.webhook_event_receipts to service_role;

drop policy if exists webhook_event_receipts_service_only on public.webhook_event_receipts;
create policy webhook_event_receipts_service_only
  on public.webhook_event_receipts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists webhook_event_receipts_set_updated_at on public.webhook_event_receipts;
create trigger webhook_event_receipts_set_updated_at
  before update on public.webhook_event_receipts
  for each row execute function public.update_updated_at_column();

create or replace function public.claim_webhook_event(
  p_tenant_id uuid,
  p_provider_event_id text,
  p_event_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  if coalesce(btrim(p_provider_event_id), '') = '' then
    return true;
  end if;

  with receipt as (
    insert into public.webhook_event_receipts (
      tenant_id, provider_event_id, event_name, status, attempt_count, locked_at, last_error
    )
    values (p_tenant_id, p_provider_event_id, p_event_name, 'processing', 1, now(), null)
    on conflict (tenant_id, provider_event_id) do update
      set event_name = excluded.event_name,
          status = 'processing',
          attempt_count = public.webhook_event_receipts.attempt_count + 1,
          locked_at = now(),
          last_error = null
      where (
          public.webhook_event_receipts.status = 'failed'
          and public.webhook_event_receipts.updated_at < now() - interval '30 seconds'
        )
        or (
           public.webhook_event_receipts.status = 'processing'
           and public.webhook_event_receipts.locked_at < now() - interval '10 minutes'
         )
    returning 1
  )
  select exists(select 1 from receipt) into claimed;

  return claimed;
end;
$$;

revoke execute on function public.claim_webhook_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_webhook_event(uuid, text, text) to service_role;

comment on table public.webhook_event_receipts is
  'Atomic idempotency receipts for provider event deliveries. A duplicate is acknowledged without reprocessing.';

notify pgrst, 'reload schema';
