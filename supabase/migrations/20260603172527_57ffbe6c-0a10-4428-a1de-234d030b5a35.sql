DROP POLICY IF EXISTS "Authenticated upload email images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update email images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete email images" ON storage.objects;

CREATE POLICY "Admins upload email images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'email-images' AND public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins update email images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'email-images' AND public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (bucket_id = 'email-images' AND public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins delete email images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'email-images' AND public.has_role(auth.uid(), 'admin'::public.app_role));