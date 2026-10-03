-- A user may belong to several tenants. Their role remains scoped to each tenant.
DROP INDEX IF EXISTS public.user_roles_one_tenant_per_user;

-- Server actions expect a single membership record per user and tenant.
-- Keep the strongest existing role if legacy data contains duplicate memberships.
DELETE FROM public.user_roles ur
USING (
  SELECT id,
    row_number() OVER (
      PARTITION BY user_id, tenant_id
      ORDER BY CASE role
        WHEN 'owner' THEN 1
        WHEN 'user' THEN 2
        WHEN 'admin' THEN 3
        WHEN 'member' THEN 4
        ELSE 5
      END,
      created_at ASC,
      id ASC
    ) AS position
  FROM public.user_roles
  WHERE tenant_id IS NOT NULL
) ranked
WHERE ur.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_membership_per_tenant
  ON public.user_roles (user_id, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- Direct database access must not be able to promote a tenant member. The
-- service-role server functions also assert this rule using the authenticated
-- actor before writing, because service_role bypasses RLS.
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
CREATE POLICY user_roles_block_tenant_admin_escalation
  ON public.user_roles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    role NOT IN ('user', 'admin', 'owner', 'super_admin')
    OR public.is_super_admin(auth.uid())
  )
  WITH CHECK (
    role NOT IN ('user', 'admin', 'owner', 'super_admin')
    OR public.is_super_admin(auth.uid())
  );
