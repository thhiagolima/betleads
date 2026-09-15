ALTER TABLE public.call_history
  ADD COLUMN IF NOT EXISTS provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_status_code integer,
  ADD COLUMN IF NOT EXISTS to_phone text;