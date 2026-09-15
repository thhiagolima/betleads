
CREATE TABLE public.system_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('ok','warning','critical')),
  title TEXT NOT NULL,
  message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX system_alerts_type_fired_idx ON public.system_alerts (alert_type, fired_at DESC);

GRANT SELECT ON public.system_alerts TO authenticated;
GRANT ALL ON public.system_alerts TO service_role;

ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read alerts" ON public.system_alerts
  FOR SELECT TO authenticated USING (true);
