
-- 1) Restrict SELECT on credential-bearing tables to owner/admin (and super_admin)
-- Members keep INSERT/UPDATE/DELETE via tenant_isolation only if they qualify by role (admin/owner via membership) — practically these are admin-managed.

-- Helper: is current user owner or admin of tenant
CREATE OR REPLACE FUNCTION public.is_tenant_admin(_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
          AND tenant_id = _tenant
          AND role IN ('owner','admin')
      )
$$;

-- whatsapp_proxies: split policy
DROP POLICY IF EXISTS whatsapp_proxies_tenant_isolation ON public.whatsapp_proxies;
CREATE POLICY whatsapp_proxies_admin_select ON public.whatsapp_proxies
  FOR SELECT TO authenticated
  USING (public.is_tenant_admin(tenant_id));
CREATE POLICY whatsapp_proxies_admin_write ON public.whatsapp_proxies
  FOR ALL TO authenticated
  USING (public.is_tenant_admin(tenant_id))
  WITH CHECK (public.is_tenant_admin(tenant_id));

-- email_smtp_configs: split policy
DROP POLICY IF EXISTS email_smtp_configs_tenant_isolation ON public.email_smtp_configs;
CREATE POLICY email_smtp_configs_admin_select ON public.email_smtp_configs
  FOR SELECT TO authenticated
  USING (public.is_tenant_admin(tenant_id));
CREATE POLICY email_smtp_configs_admin_write ON public.email_smtp_configs
  FOR ALL TO authenticated
  USING (public.is_tenant_admin(tenant_id))
  WITH CHECK (public.is_tenant_admin(tenant_id));

-- call_providers: split policy
DROP POLICY IF EXISTS call_providers_tenant_isolation ON public.call_providers;
CREATE POLICY call_providers_admin_select ON public.call_providers
  FOR SELECT TO authenticated
  USING (public.is_tenant_admin(tenant_id));
CREATE POLICY call_providers_admin_write ON public.call_providers
  FOR ALL TO authenticated
  USING (public.is_tenant_admin(tenant_id))
  WITH CHECK (public.is_tenant_admin(tenant_id));

-- 2) tenants.webhook_token: hide column from non-owners/admins via column-level GRANT.
-- Revoke webhook_token column read from authenticated; only service_role retains it.
REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
-- Grant SELECT on all other columns explicitly so members keep tenant info access.
GRANT SELECT (id, nome, slug, status, plano, limits, metadata, created_at, updated_at) ON public.tenants TO authenticated;

-- Helper for owners/admins to fetch the webhook token via SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.get_tenant_webhook_token(_tenant uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v text;
BEGIN
  IF NOT public.is_tenant_admin(_tenant) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT webhook_token INTO v FROM public.tenants WHERE id = _tenant;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.get_tenant_webhook_token(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_tenant_webhook_token(uuid) TO authenticated;

-- 3) Remove public read policy on email-images storage bucket.
-- WARNING: This will break image rendering inside delivered emails for clients
-- that do not present a session. Replace fetching with signed URLs at send time.
DROP POLICY IF EXISTS "Email images public read" ON storage.objects;
