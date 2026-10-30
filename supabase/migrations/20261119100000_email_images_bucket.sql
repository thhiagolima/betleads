-- The email-images bucket was never created (only its policies were), so
-- uploads from the e-mail editors failed with "Bucket not found".
-- Public: mail clients (Gmail, Outlook) fetch template images without a
-- session. Writes stay restricted by the tenant_*_email_images policies
-- (first folder = tenant id, or super admin).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-images',
  'email-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
