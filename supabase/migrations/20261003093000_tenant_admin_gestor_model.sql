-- Canonical tenant roles: one admin, operational managers and members.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'gestor';

-- Convert legacy administrative roles while preserving one principal per tenant.
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY tenant_id
      ORDER BY CASE role
        WHEN 'owner' THEN 1
        WHEN 'user' THEN 2
        WHEN 'admin' THEN 3
        ELSE 4
      END,
      created_at ASC,
      id ASC
    ) AS position
  FROM public.user_roles
  WHERE tenant_id IS NOT NULL
    AND role IN ('owner', 'user', 'admin')
)
UPDATE public.user_roles ur
SET role = CASE WHEN ranked.position = 1 THEN 'admin'::public.app_role ELSE 'gestor'::public.app_role END
FROM ranked
WHERE ur.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_admin_per_tenant
  ON public.user_roles (tenant_id)
  WHERE role = 'admin';

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim text;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_claim := current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id';
    IF v_claim IS NOT NULL AND v_claim <> '' AND public.is_super_admin(v_uid) THEN
      RETURN v_claim::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT tenant_id INTO v_tenant
  FROM public.user_roles
  WHERE user_id = v_uid
    AND tenant_id IS NOT NULL
    AND role IN ('admin', 'gestor', 'member')
  ORDER BY tenant_id
  LIMIT 1;
  RETURN v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_access(_tenant_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin(_user_id) OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND tenant_id = _tenant_id
      AND role IN ('admin', 'gestor', 'member')
  )
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_owner(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin() OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND tenant_id = _tenant AND role = 'admin'
  )
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_super_admin() OR EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND tenant_id = _tenant AND role = 'admin'
  )
$$;

DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
CREATE POLICY user_roles_block_tenant_admin_escalation
  ON public.user_roles AS RESTRICTIVE FOR ALL TO authenticated
  USING (role <> 'admin' OR public.is_super_admin(auth.uid()))
  WITH CHECK (role <> 'admin' OR public.is_super_admin(auth.uid()));
