
-- Public read of email images so they can be referenced in sent emails
CREATE POLICY "Email images public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'email-images');

-- Authenticated users (admins) can upload/manage email images
CREATE POLICY "Authenticated upload email images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'email-images');

CREATE POLICY "Authenticated update email images"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'email-images');

CREATE POLICY "Authenticated delete email images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'email-images');
