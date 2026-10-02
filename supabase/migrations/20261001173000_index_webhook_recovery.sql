create index if not exists webhook_logs_event_status_created_idx
  on public.webhook_logs (evento, status, created_at desc);

create index if not exists webhook_logs_tenant_event_created_idx
  on public.webhook_logs (tenant_id, evento, created_at desc);
