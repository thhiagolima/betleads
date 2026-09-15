ALTER TABLE public.sms_send_logs
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS last_callback jsonb;

CREATE INDEX IF NOT EXISTS idx_sms_send_logs_provider_message_id ON public.sms_send_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_sms_send_logs_idempotency_key ON public.sms_send_logs(idempotency_key);