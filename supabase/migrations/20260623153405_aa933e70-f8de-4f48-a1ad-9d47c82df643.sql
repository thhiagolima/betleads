ALTER TABLE public.sms_flow_steps
  ADD COLUMN IF NOT EXISTS scheduled_time TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_day_offset INTEGER;

COMMENT ON COLUMN public.sms_flow_steps.scheduled_time IS 'HH:MM em America/Sao_Paulo. Quando definido junto com scheduled_day_offset, o dispatcher agenda o envio no dia/horario exato em vez de usar delay_days. Usado pelo modelo CRM_EXPERT.';
COMMENT ON COLUMN public.sms_flow_steps.scheduled_day_offset IS 'Dias desde o entered_at (0 = primeiro dia). Usado em conjunto com scheduled_time para agendamento fixo. Usado pelo modelo CRM_EXPERT.';