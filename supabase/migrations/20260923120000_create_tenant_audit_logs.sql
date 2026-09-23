-- Tenant administrative audit trail.
-- The application writes to this table through server-side admin functions.
-- Tenants may read their own audit history; super admins may read everything.

CREATE TABLE IF NOT EXISTS public.tenant_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 2 AND 120),
  entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 2 AND 80),
  entity_id text NULL,
  before_data jsonb NULL,
  after_data jsonb NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_audit_logs_tenant_created
  ON public.tenant_audit_logs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_audit_logs_actor_created
  ON public.tenant_audit_logs(actor_user_id, created_at DESC);

ALTER TABLE public.tenant_audit_logs ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.tenant_audit_logs TO authenticated;
GRANT ALL ON public.tenant_audit_logs TO service_role;

DROP POLICY IF EXISTS tenant_audit_logs_read_own ON public.tenant_audit_logs;
CREATE POLICY tenant_audit_logs_read_own
  ON public.tenant_audit_logs FOR SELECT TO authenticated
  USING (public.has_tenant_access(tenant_id));

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- Writes are performed only by trusted server functions through service_role.
