ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS sms_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS call_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_paused boolean NOT NULL DEFAULT false;