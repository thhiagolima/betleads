REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated, anon;
GRANT SELECT (webhook_token) ON public.tenants TO service_role;