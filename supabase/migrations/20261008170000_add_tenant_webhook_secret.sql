-- The public webhook receiver validates an optional HMAC stored per tenant.
-- This column was used by the application before it was added to the schema,
-- causing PostgREST to reject the receiver's tenant lookup with SQLSTATE 42703.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS webhook_secret text;

COMMENT ON COLUMN public.tenants.webhook_secret IS
  'Optional HMAC SHA-256 secret used to validate inbound tenant webhooks.';
