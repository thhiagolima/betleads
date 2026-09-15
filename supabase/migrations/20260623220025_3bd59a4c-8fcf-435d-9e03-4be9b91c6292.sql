ALTER TABLE public.email_flow_blocks
  ADD COLUMN IF NOT EXISTS send_at_hour smallint,
  ADD COLUMN IF NOT EXISTS send_at_minute smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skip_if_past boolean NOT NULL DEFAULT false;