ALTER TABLE public.chat_providers
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'mirror',
  ADD COLUMN IF NOT EXISTS forward_url text,
  ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_providers_mode_check'
  ) THEN
    ALTER TABLE public.chat_providers
      ADD CONSTRAINT chat_providers_mode_check CHECK (mode IN ('mirror','proxy'));
  END IF;
END$$;