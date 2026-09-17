CREATE TABLE IF NOT EXISTS public.player_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid) REFERENCES public.tenants(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  event_id text,
  event_type text NOT NULL DEFAULT 'signup',
  provider text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  utm_id text,
  fbclid text,
  gclid text,
  gbraid text,
  wbraid text,
  ttclid text,
  msclkid text,
  trackgram_click_id text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (
    match_status IN (
      'matched_ad_id',
      'matched_ad_name',
      'matched_campaign_name',
      'orphan_campaign',
      'missing_utm',
      'unmatched'
    )
  ),
  match_confidence numeric(5,2) NOT NULL DEFAULT 0,
  matched_ad_account_id text,
  matched_campaign_id text,
  matched_adset_id text,
  matched_ad_id text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, player_id, event_type)
);

CREATE INDEX IF NOT EXISTS player_attributions_tenant_captured_idx
  ON public.player_attributions (tenant_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS player_attributions_tenant_match_idx
  ON public.player_attributions (tenant_id, match_status);

CREATE INDEX IF NOT EXISTS player_attributions_tenant_utm_id_idx
  ON public.player_attributions (tenant_id, utm_id)
  WHERE utm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS player_attributions_tenant_utm_content_idx
  ON public.player_attributions (tenant_id, utm_content)
  WHERE utm_content IS NOT NULL;

CREATE INDEX IF NOT EXISTS player_attributions_tenant_utm_campaign_idx
  ON public.player_attributions (tenant_id, utm_campaign)
  WHERE utm_campaign IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.player_attributions TO authenticated;
GRANT ALL ON public.player_attributions TO service_role;

ALTER TABLE public.player_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS player_attributions_tenant_isolation ON public.player_attributions;
CREATE POLICY player_attributions_tenant_isolation
  ON public.player_attributions
  FOR ALL
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

DROP TRIGGER IF EXISTS player_attributions_set_updated_at ON public.player_attributions;
CREATE TRIGGER player_attributions_set_updated_at
  BEFORE UPDATE ON public.player_attributions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.player_attributions IS
  'Declared attribution captured from signup/webhook payloads. Match fields indicate whether the declared source was found in connected ad accounts.';
