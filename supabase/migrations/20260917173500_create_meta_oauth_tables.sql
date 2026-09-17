CREATE TABLE IF NOT EXISTS public.meta_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  nonce text NOT NULL UNIQUE,
  return_to text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.meta_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connected_by_user_id uuid NOT NULL,
  meta_user_id text NOT NULL,
  meta_user_name text,
  access_token text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disabled')),
  last_error text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meta_user_id)
);

CREATE TABLE IF NOT EXISTS public.meta_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.meta_connections(id) ON DELETE CASCADE,
  meta_ad_account_id text NOT NULL,
  account_id text,
  name text,
  business_id text,
  business_name text,
  currency text,
  timezone_name text,
  account_status integer,
  selected boolean NOT NULL DEFAULT true,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meta_ad_account_id)
);

CREATE INDEX IF NOT EXISTS meta_oauth_states_nonce_idx
  ON public.meta_oauth_states (nonce);

CREATE INDEX IF NOT EXISTS meta_oauth_states_expires_idx
  ON public.meta_oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS meta_connections_tenant_idx
  ON public.meta_connections (tenant_id, status);

CREATE INDEX IF NOT EXISTS meta_ad_accounts_tenant_idx
  ON public.meta_ad_accounts (tenant_id, selected);

GRANT ALL ON public.meta_oauth_states TO service_role;
GRANT ALL ON public.meta_connections TO service_role;
GRANT ALL ON public.meta_ad_accounts TO service_role;
GRANT SELECT, UPDATE ON public.meta_ad_accounts TO authenticated;

ALTER TABLE public.meta_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ad_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_oauth_states_service_only ON public.meta_oauth_states;
CREATE POLICY meta_oauth_states_service_only
  ON public.meta_oauth_states
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS meta_connections_service_only ON public.meta_connections;
CREATE POLICY meta_connections_service_only
  ON public.meta_connections
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS meta_ad_accounts_tenant_select ON public.meta_ad_accounts;
CREATE POLICY meta_ad_accounts_tenant_select
  ON public.meta_ad_accounts
  FOR SELECT
  USING (public.has_tenant_access(tenant_id));

DROP POLICY IF EXISTS meta_ad_accounts_tenant_update ON public.meta_ad_accounts;
CREATE POLICY meta_ad_accounts_tenant_update
  ON public.meta_ad_accounts
  FOR UPDATE
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

DROP TRIGGER IF EXISTS meta_connections_set_updated_at ON public.meta_connections;
CREATE TRIGGER meta_connections_set_updated_at
  BEFORE UPDATE ON public.meta_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS meta_ad_accounts_set_updated_at ON public.meta_ad_accounts;
CREATE TRIGGER meta_ad_accounts_set_updated_at
  BEFORE UPDATE ON public.meta_ad_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.meta_connections IS
  'Server-only Meta OAuth connections. Never grant authenticated SELECT on access_token.';

COMMENT ON TABLE public.meta_ad_accounts IS
  'Tenant-scoped Meta ad accounts discovered from OAuth connections. A tenant can have many accounts.';
