-- 1) Corrige escalonamento de privilégio: is_tenant_owner não pode aceitar 'user'
CREATE OR REPLACE FUNCTION public.is_tenant_owner(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND tenant_id = _tenant
      AND role = 'owner'
  )
$$;

-- 2) Restringe leitura do token de webhook de tenants: somente super admin (via grant) e RPC SECURITY DEFINER
REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
REVOKE SELECT (webhook_token) ON public.tenants FROM anon;

-- 3) Restringe leitura do secret de webhook_configs: somente super admin / service role
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated;
REVOKE SELECT (secret) ON public.webhook_configs FROM anon;