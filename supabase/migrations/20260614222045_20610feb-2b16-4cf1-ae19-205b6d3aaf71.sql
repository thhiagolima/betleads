REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated, anon;
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated, anon;

GRANT SELECT (
  id, nome, slug, status, plano, limits, metadata, created_at, updated_at, legacy_webhook
) ON public.tenants TO authenticated;

GRANT SELECT (
  id, nome, url, ativo, ultima_conexao, created_at, tenant_id
) ON public.webhook_configs TO authenticated;

GRANT ALL ON public.tenants TO service_role;
GRANT ALL ON public.webhook_configs TO service_role;