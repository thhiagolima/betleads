-- The active tenant is sent by authenticated server-function requests in the
-- X-Active-Tenant header. It is always revalidated against memberships here.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_requested text;
  v_tenant uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;

  BEGIN
    v_requested := current_setting('request.headers', true)::jsonb ->> 'x-active-tenant';
    IF v_requested IS NOT NULL AND v_requested <> '' THEN
      v_tenant := v_requested::uuid;
      IF public.has_tenant_access(v_tenant, v_uid) THEN
        RETURN v_tenant;
      END IF;
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

-- Direct browser queries must obey the selected tenant as well. Server-side
-- service-role actions remain protected by their explicit authorization checks.
DO $migration$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'tenant_id'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = target.table_schema
        AND tablename = target.table_name
        AND policyname = 'tenant_isolation_guard'
    ) THEN
      EXECUTE format('DROP POLICY tenant_isolation_guard ON %I.%I', target.table_schema, target.table_name);
      EXECUTE format(
        'CREATE POLICY tenant_isolation_guard ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (tenant_id = public.current_tenant_id() OR public.is_super_admin()) WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin())',
        target.table_schema, target.table_name
      );
    END IF;
  END LOOP;
END
$migration$;
