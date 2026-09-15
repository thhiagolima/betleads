ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS legacy_webhook boolean NOT NULL DEFAULT false;
UPDATE public.tenants SET legacy_webhook = true WHERE id = '00000000-0000-0000-0000-000000000001';
CREATE UNIQUE INDEX IF NOT EXISTS tenants_only_one_legacy_webhook ON public.tenants ((legacy_webhook)) WHERE legacy_webhook = true;