ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS rate_per_minute integer NOT NULL DEFAULT 1000;