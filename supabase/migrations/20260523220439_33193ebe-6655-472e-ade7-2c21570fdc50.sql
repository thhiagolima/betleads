-- Make whatsapp-media bucket private
UPDATE storage.buckets SET public = false WHERE id = 'whatsapp-media';

-- Drop any existing permissive policies for this bucket (safe no-op if absent)
DROP POLICY IF EXISTS "whatsapp-media admin read" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin write" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin update" ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media admin delete" ON storage.objects;

-- Admin-only SELECT (needed to generate signed URLs)
CREATE POLICY "whatsapp-media admin read"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND public.has_role(auth.uid(), 'admin')
);

-- Admin-only INSERT
CREATE POLICY "whatsapp-media admin write"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'whatsapp-media'
  AND public.has_role(auth.uid(), 'admin')
);

-- Admin-only UPDATE
CREATE POLICY "whatsapp-media admin update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND public.has_role(auth.uid(), 'admin')
)
WITH CHECK (
  bucket_id = 'whatsapp-media'
  AND public.has_role(auth.uid(), 'admin')
);

-- Admin-only DELETE
CREATE POLICY "whatsapp-media admin delete"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'whatsapp-media'
  AND public.has_role(auth.uid(), 'admin')
);