-- Defense in depth for every tenant-owned table.
--
-- Existing policies remain in place, but this restrictive policy is ANDed
-- with them. Therefore an accidentally broad permissive policy cannot expose
-- another tenant. `has_tenant_access` intentionally returns true for a global
-- super_admin, preserving full administrative visibility.

DO $migration$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      target.table_schema,
      target.table_name
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = target.table_schema
        AND tablename = target.table_name
        AND policyname = 'tenant_access_base'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_access_base ON %I.%I AS PERMISSIVE FOR ALL TO authenticated USING (public.has_tenant_access(tenant_id)) WITH CHECK (public.has_tenant_access(tenant_id))',
        target.table_schema,
        target.table_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = target.table_schema
        AND tablename = target.table_name
        AND policyname = 'tenant_isolation_guard'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation_guard ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.has_tenant_access(tenant_id)) WITH CHECK (public.has_tenant_access(tenant_id))',
        target.table_schema,
        target.table_name
      );
    END IF;
  END LOOP;
END
$migration$;

-- The helper functions are security boundaries. Do not allow application
-- users to replace them, while keeping execution available to authenticated
-- sessions and the service role.
REVOKE ALL ON FUNCTION public.has_tenant_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_tenant_access(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_super_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;
