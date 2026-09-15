
REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated;
REVOKE SELECT (webhook_token) ON public.tenants FROM anon;
REVOKE SELECT (secret) ON public.webhook_configs FROM anon;

GRANT SELECT (id, nome, slug, status, plano, limits, metadata, created_at, updated_at, legacy_webhook)
  ON public.tenants TO authenticated;

GRANT SELECT (id, nome, url, ativo, ultima_conexao, created_at, tenant_id)
  ON public.webhook_configs TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_webhook_token(_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v text;
BEGIN
  IF NOT public.is_tenant_admin(_tenant) THEN
    RETURN NULL;
  END IF;
  SELECT webhook_token INTO v FROM public.tenants WHERE id = _tenant;
  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_webhook_token(uuid) TO authenticated;
