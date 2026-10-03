-- Diário imutável das tentativas financeiras. O webhook_logs continua sendo a
-- fila operacional; esta tabela preserva o payload original e o resultado de
-- cada tentativa para auditoria e reprocessamento seguro.
create table if not exists public.financial_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  webhook_log_id uuid references public.webhook_logs(id) on delete set null,
  provider_event_id text,
  event_name text not null,
  parser_version text not null,
  raw_payload jsonb not null,
  normalized_event jsonb not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists financial_webhook_attempts_tenant_status_created_idx
  on public.financial_webhook_attempts (tenant_id, status, created_at desc);

create index if not exists financial_webhook_attempts_tenant_provider_event_idx
  on public.financial_webhook_attempts (tenant_id, provider_event_id)
  where provider_event_id is not null;

alter table public.financial_webhook_attempts enable row level security;

grant all on public.financial_webhook_attempts to service_role;

drop policy if exists financial_webhook_attempts_service_only
  on public.financial_webhook_attempts;
create policy financial_webhook_attempts_service_only
  on public.financial_webhook_attempts
  for all to service_role
  using (true)
  with check (true);

drop trigger if exists financial_webhook_attempts_set_updated_at
  on public.financial_webhook_attempts;
create trigger financial_webhook_attempts_set_updated_at
  before update on public.financial_webhook_attempts
  for each row execute function public.update_updated_at_column();

comment on table public.financial_webhook_attempts is
  'Immutable raw payload and normalized result for each financial webhook processing attempt.';

notify pgrst, 'reload schema';
