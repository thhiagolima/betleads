CREATE TABLE public.sms_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_phone text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  provider text NOT NULL DEFAULT 'businesscode',
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  idempotency_key text,
  player_id uuid,
  flow_id uuid,
  trigger_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sms_send_logs_created_at ON public.sms_send_logs (created_at DESC);
CREATE INDEX idx_sms_send_logs_player ON public.sms_send_logs (player_id);

GRANT SELECT ON public.sms_send_logs TO authenticated;
GRANT ALL ON public.sms_send_logs TO service_role;

ALTER TABLE public.sms_send_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access sms_send_logs"
ON public.sms_send_logs
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));