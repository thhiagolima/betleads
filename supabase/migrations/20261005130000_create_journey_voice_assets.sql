CREATE TABLE public.journey_voice_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  storage_path text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journey_voice_assets_tenant_created_idx ON public.journey_voice_assets(tenant_id, created_at DESC);
ALTER TABLE public.journey_voice_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY journey_voice_assets_tenant_access ON public.journey_voice_assets FOR ALL TO authenticated
USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id());
CREATE TRIGGER set_updated_at_journey_voice_assets BEFORE UPDATE ON public.journey_voice_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journey_voice_assets TO authenticated;
GRANT ALL ON public.journey_voice_assets TO service_role;
