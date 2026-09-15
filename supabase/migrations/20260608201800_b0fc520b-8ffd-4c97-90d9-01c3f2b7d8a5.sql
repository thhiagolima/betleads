
-- 1) Tabela de tenants
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','trial','canceled')),
  plano text NOT NULL DEFAULT 'starter' CHECK (plano IN ('starter','pro','enterprise','interno')),
  webhook_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  limits jsonb NOT NULL DEFAULT '{"sms_mensal_max": null, "email_mensal_max": null, "ligacoes_mensal_max": null}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Tenant default "BetLeads Original"
INSERT INTO public.tenants (id, nome, slug, status, plano)
VALUES ('00000000-0000-0000-0000-000000000001', 'BetLeads Original', 'betleads-original', 'active', 'interno');

-- 3) Adicionar tenant_id em user_roles
ALTER TABLE public.user_roles
  ADD COLUMN tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_role_key;
CREATE UNIQUE INDEX user_roles_user_tenant_role_uniq
  ON public.user_roles (user_id, COALESCE(tenant_id::text, 'GLOBAL'), role);
CREATE INDEX IF NOT EXISTS user_roles_tenant_id_idx ON public.user_roles (tenant_id);

-- 4) Promover usuário existente a super_admin + owner do tenant default
INSERT INTO public.user_roles (user_id, role, tenant_id)
SELECT '28e9680b-3c23-454e-b0cc-56f58aadb478', 'super_admin', NULL
WHERE EXISTS (
  SELECT 1 FROM auth.users WHERE id = '28e9680b-3c23-454e-b0cc-56f58aadb478'
);

INSERT INTO public.user_roles (user_id, role, tenant_id)
SELECT '28e9680b-3c23-454e-b0cc-56f58aadb478', 'owner', '00000000-0000-0000-0000-000000000001'
WHERE EXISTS (
  SELECT 1 FROM auth.users WHERE id = '28e9680b-3c23-454e-b0cc-56f58aadb478'
);

-- 5) Helpers (SECURITY DEFINER — não recursivo)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'super_admin'
  )
$$;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_claim text;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- Claim 'tenant_id' no JWT (setado quando super_admin impersona)
  BEGIN
    v_claim := current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id';
    IF v_claim IS NOT NULL AND v_claim <> '' THEN
      RETURN v_claim::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT tenant_id INTO v_tenant
  FROM public.user_roles
  WHERE user_id = v_uid
    AND tenant_id IS NOT NULL
    AND role IN ('owner','member','admin')
  ORDER BY tenant_id ASC
  LIMIT 1;

  RETURN v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_access(_tenant_id uuid, _user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.is_super_admin(_user_id)
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id
        AND tenant_id = _tenant_id
        AND role IN ('owner','member','admin')
    )
$$;

-- 6) RLS de tenants
CREATE POLICY "tenants_super_admin_all" ON public.tenants
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY "tenants_member_select_own" ON public.tenants
  FOR SELECT TO authenticated
  USING (public.has_tenant_access(id));

-- 7) RLS de user_roles
DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Only admins can manage roles" ON public.user_roles;

CREATE POLICY "user_roles_select_own" ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin());

CREATE POLICY "user_roles_super_admin_all" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY "user_roles_owner_manage_tenant" ON public.user_roles
  FOR ALL TO authenticated
  USING (
    tenant_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.tenant_id = user_roles.tenant_id
        AND ur.role = 'owner'
    )
  )
  WITH CHECK (
    tenant_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.tenant_id = user_roles.tenant_id
        AND ur.role = 'owner'
    )
  );
