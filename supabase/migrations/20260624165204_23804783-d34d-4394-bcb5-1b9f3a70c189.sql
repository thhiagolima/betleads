-- Revoke column-level SELECT on tenants.webhook_token from regular users.
REVOKE SELECT (webhook_token) ON public.tenants FROM authenticated;
REVOKE SELECT (webhook_token) ON public.tenants FROM anon;

-- Tighten suppressed_emails: NULL-tenant (global) rows are super_admin only.
DROP POLICY IF EXISTS "tenant members can view suppression list" ON public.suppressed_emails;
CREATE POLICY "tenant members can view suppression list"
  ON public.suppressed_emails
  FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.has_tenant_access(tenant_id))
  );