DROP POLICY IF EXISTS user_roles_owner_manage_tenant ON public.user_roles;

CREATE OR REPLACE FUNCTION public.is_tenant_owner(_tenant uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND tenant_id = _tenant
      AND role = 'owner'
  )
$$;

REVOKE ALL ON FUNCTION public.is_tenant_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_tenant_owner(uuid) TO authenticated;

CREATE POLICY user_roles_owner_manage_tenant
ON public.user_roles
FOR ALL TO authenticated
USING (tenant_id IS NOT NULL AND public.is_tenant_owner(tenant_id))
WITH CHECK (tenant_id IS NOT NULL AND public.is_tenant_owner(tenant_id));