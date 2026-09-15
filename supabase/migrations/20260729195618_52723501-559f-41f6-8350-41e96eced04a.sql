CREATE TABLE public.whatsapp_external_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  url text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  triggers text[] NOT NULL DEFAULT '{}',
  disable_internal boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_external_integrations TO authenticated;
GRANT ALL ON public.whatsapp_external_integrations TO service_role;
ALTER TABLE public.whatsapp_external_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wei_tenant_isolation" ON public.whatsapp_external_integrations
  FOR ALL TO authenticated
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

CREATE TRIGGER wei_set_updated_at BEFORE UPDATE ON public.whatsapp_external_integrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.whatsapp_external_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  phone_e164 text,
  trigger_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  http_status integer,
  response_body text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_external_events_once
  ON public.whatsapp_external_events (tenant_id, player_id, trigger_type)
  WHERE player_id IS NOT NULL AND is_test = false;
CREATE INDEX whatsapp_external_events_tenant_created_idx
  ON public.whatsapp_external_events (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_external_events TO authenticated;
GRANT ALL ON public.whatsapp_external_events TO service_role;
ALTER TABLE public.whatsapp_external_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wee_tenant_isolation" ON public.whatsapp_external_events
  FOR ALL TO authenticated
  USING (public.has_tenant_access(tenant_id))
  WITH CHECK (public.has_tenant_access(tenant_id));

CREATE TRIGGER wee_set_updated_at BEFORE UPDATE ON public.whatsapp_external_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();