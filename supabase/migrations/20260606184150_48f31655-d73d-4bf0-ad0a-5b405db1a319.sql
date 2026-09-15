ALTER TABLE public.call_queue
  ADD COLUMN IF NOT EXISTS provider_response jsonb,
  ADD COLUMN IF NOT EXISTS provider_request_id text;