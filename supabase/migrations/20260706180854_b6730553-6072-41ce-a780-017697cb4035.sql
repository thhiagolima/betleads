CREATE INDEX IF NOT EXISTS webhook_logs_tenant_status_created_idx
  ON public.webhook_logs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_logs_tenant_event_created_idx
  ON public.webhook_logs (tenant_id, evento, created_at DESC);

CREATE INDEX IF NOT EXISTS deposits_tenant_status_created_idx
  ON public.deposits (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS withdrawals_tenant_status_created_idx
  ON public.withdrawals (tenant_id, status, created_at DESC);
