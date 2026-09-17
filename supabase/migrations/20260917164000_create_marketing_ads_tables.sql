ALTER TABLE public.players ADD COLUMN IF NOT EXISTS utm_content text;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS utm_term text;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS utm_id text;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS players_tenant_utm_id_idx
  ON public.players (tenant_id, utm_id)
  WHERE utm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS players_tenant_utm_content_idx
  ON public.players (tenant_id, utm_content)
  WHERE utm_content IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.marketing_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid) REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('meta', 'windsor', 'csv')),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'configured', 'connected', 'error', 'disabled')),
  account_name text,
  external_account_id text,
  currency text NOT NULL DEFAULT 'BRL',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  token_expires_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_account_id)
);

CREATE TABLE IF NOT EXISTS public.marketing_ad_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid) REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('meta', 'google', 'tiktok', 'kwai', 'csv', 'windsor')),
  ad_account_id text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text,
  ad_name text,
  creative_name text,
  metric_date date NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  ctr numeric(10,4),
  cpc numeric(14,4),
  cpm numeric(14,4),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, metric_date, ad_account_id, ad_id)
);

CREATE INDEX IF NOT EXISTS marketing_integrations_tenant_provider_idx
  ON public.marketing_integrations (tenant_id, provider);

CREATE INDEX IF NOT EXISTS marketing_ad_metrics_daily_tenant_date_idx
  ON public.marketing_ad_metrics_daily (tenant_id, metric_date DESC);

CREATE INDEX IF NOT EXISTS marketing_ad_metrics_daily_tenant_creative_idx
  ON public.marketing_ad_metrics_daily (tenant_id, provider, ad_name);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_integrations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_ad_metrics_daily TO authenticated;
GRANT ALL ON public.marketing_integrations TO service_role;
GRANT ALL ON public.marketing_ad_metrics_daily TO service_role;

ALTER TABLE public.marketing_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_ad_metrics_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_integrations_tenant_isolation ON public.marketing_integrations;
CREATE POLICY marketing_integrations_tenant_isolation
  ON public.marketing_integrations
  FOR ALL
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

DROP POLICY IF EXISTS marketing_ad_metrics_daily_tenant_isolation ON public.marketing_ad_metrics_daily;
CREATE POLICY marketing_ad_metrics_daily_tenant_isolation
  ON public.marketing_ad_metrics_daily
  FOR ALL
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

DROP TRIGGER IF EXISTS marketing_integrations_set_updated_at ON public.marketing_integrations;
CREATE TRIGGER marketing_integrations_set_updated_at
  BEFORE UPDATE ON public.marketing_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS marketing_ad_metrics_daily_set_updated_at ON public.marketing_ad_metrics_daily;
CREATE TRIGGER marketing_ad_metrics_daily_set_updated_at
  BEFORE UPDATE ON public.marketing_ad_metrics_daily
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.marketing_integrations IS
  'Tenant-scoped metadata for ad data connectors. OAuth tokens must remain server-only and must not be exposed to authenticated clients.';

COMMENT ON TABLE public.marketing_ad_metrics_daily IS
  'Daily ad spend and delivery metrics normalized by creative/ad for LTV attribution.';
