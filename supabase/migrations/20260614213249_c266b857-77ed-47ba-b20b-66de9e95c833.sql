
ALTER TABLE public.sms_send_logs
  ADD COLUMN IF NOT EXISTS step_index INT,
  ADD COLUMN IF NOT EXISTS step_label TEXT,
  ADD COLUMN IF NOT EXISTS flow_lead_id UUID;

ALTER TABLE public.email_send_logs
  ADD COLUMN IF NOT EXISTS flow_id UUID,
  ADD COLUMN IF NOT EXISTS block_index INT,
  ADD COLUMN IF NOT EXISTS step_label TEXT,
  ADD COLUMN IF NOT EXISTS flow_lead_id UUID;

CREATE INDEX IF NOT EXISTS idx_sms_send_logs_flow_created ON public.sms_send_logs (flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_logs_flow_lead ON public.sms_send_logs (flow_lead_id);
CREATE INDEX IF NOT EXISTS idx_email_send_logs_flow_created ON public.email_send_logs (flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_logs_flow_lead ON public.email_send_logs (flow_lead_id);
