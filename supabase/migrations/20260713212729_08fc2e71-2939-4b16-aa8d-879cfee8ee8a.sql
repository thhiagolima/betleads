REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
REVOKE SELECT (webhook_token) ON public.tenants FROM anon;

GRANT SELECT (
  id, nome, slug, status, plano, limits, metadata,
  created_at, updated_at, legacy_webhook, crm_model
) ON public.tenants TO authenticated;

GRANT INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;