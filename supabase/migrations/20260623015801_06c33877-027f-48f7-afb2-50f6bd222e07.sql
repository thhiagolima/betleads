REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
REVOKE SELECT (webhook_token) ON public.tenants FROM anon;
REVOKE SELECT (webhook_token) ON public.tenants FROM PUBLIC;

GRANT SELECT (id, nome, slug, status, plano, limits, metadata, created_at, updated_at, legacy_webhook)
  ON public.tenants TO authenticated;

GRANT ALL ON public.tenants TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_tenant_per_user
  ON public.user_roles (user_id)
  WHERE tenant_id IS NOT NULL AND role IN ('user','owner','member','admin');