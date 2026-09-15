
DROP POLICY IF EXISTS email_senders_super_admin_read ON public.email_senders;
DROP POLICY IF EXISTS email_senders_super_admin_write ON public.email_senders;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_senders TO authenticated;
GRANT ALL ON public.email_senders TO service_role;

CREATE POLICY email_senders_tenant_select ON public.email_senders
  FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

CREATE POLICY email_senders_tenant_insert ON public.email_senders
  FOR INSERT TO authenticated
  WITH CHECK (public.has_tenant_access(tenant_id));

CREATE POLICY email_senders_tenant_update ON public.email_senders
  FOR UPDATE TO authenticated
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

CREATE POLICY email_senders_tenant_delete ON public.email_senders
  FOR DELETE TO authenticated
  USING (public.has_tenant_access(tenant_id));
