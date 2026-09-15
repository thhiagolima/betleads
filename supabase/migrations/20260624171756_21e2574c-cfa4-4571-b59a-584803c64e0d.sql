
-- Fix 1: Restrict webhook_configs.secret to tenant admins/super_admin only.
-- Revoke column-level SELECT on `secret` from authenticated role (matches the
-- pattern used for tenants.webhook_token). Other columns remain readable to
-- tenant members under the existing RLS policy.
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated;
REVOKE SELECT (secret) ON public.webhook_configs FROM anon;

-- Re-grant SELECT on the non-sensitive columns explicitly to authenticated so
-- that PostgREST can still serve listing queries.
GRANT SELECT (id, nome, url, ativo, ultima_conexao, created_at, tenant_id)
  ON public.webhook_configs TO authenticated;

-- Allow tenant admins/owners and super_admins to fetch the raw secret via a
-- SECURITY DEFINER function (mirrors get_tenant_webhook_token pattern).
CREATE OR REPLACE FUNCTION public.get_webhook_config_secret(_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_secret text;
BEGIN
  SELECT tenant_id, secret INTO v_tenant, v_secret
    FROM public.webhook_configs
   WHERE id = _id;

  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT public.is_tenant_admin(v_tenant) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.get_webhook_config_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_webhook_config_secret(uuid) TO authenticated;

-- Fix 2: Add explicit write policies on suppressed_emails that forbid
-- non-super_admin users from creating/updating/deleting rows with NULL
-- tenant_id (global suppression entries). Super_admin retains full control.
CREATE POLICY "suppressed_emails_tenant_insert"
  ON public.suppressed_emails
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.has_tenant_access(tenant_id))
  );

CREATE POLICY "suppressed_emails_tenant_update"
  ON public.suppressed_emails
  FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.has_tenant_access(tenant_id))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.has_tenant_access(tenant_id))
  );

CREATE POLICY "suppressed_emails_tenant_delete"
  ON public.suppressed_emails
  FOR DELETE
  TO authenticated
  USING (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.has_tenant_access(tenant_id))
  );
