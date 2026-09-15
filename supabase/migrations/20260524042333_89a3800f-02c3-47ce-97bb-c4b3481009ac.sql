ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS sender_jid text,
  ADD COLUMN IF NOT EXISTS sender_name text;