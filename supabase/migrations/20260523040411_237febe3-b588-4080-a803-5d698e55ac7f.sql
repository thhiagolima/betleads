
-- 1) Storage bucket para mídia do WhatsApp (público para o navegador renderizar)
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', true)
ON CONFLICT (id) DO NOTHING;

-- Policies do bucket
DROP POLICY IF EXISTS "whatsapp-media public read" ON storage.objects;
CREATE POLICY "whatsapp-media public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'whatsapp-media');

DROP POLICY IF EXISTS "whatsapp-media admins write" ON storage.objects;
CREATE POLICY "whatsapp-media admins write"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'whatsapp-media' AND has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "whatsapp-media admins update" ON storage.objects;
CREATE POLICY "whatsapp-media admins update"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'whatsapp-media' AND has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "whatsapp-media admins delete" ON storage.objects;
CREATE POLICY "whatsapp-media admins delete"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'whatsapp-media' AND has_role(auth.uid(), 'admin'::app_role));

-- 2) Colunas extras de mídia em whatsapp_messages
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_mimetype text,
  ADD COLUMN IF NOT EXISTS media_filename text,
  ADD COLUMN IF NOT EXISTS media_size bigint,
  ADD COLUMN IF NOT EXISTS media_duration integer;

-- 3) Garantir realtime nas tabelas do inbox
ALTER TABLE public.whatsapp_messages REPLICA IDENTITY FULL;
ALTER TABLE public.whatsapp_chats REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_chats;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
