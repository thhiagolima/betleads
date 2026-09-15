CREATE TABLE public.dashboard_settings (
  id text PRIMARY KEY DEFAULT 'global',
  reset_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

GRANT SELECT, INSERT, UPDATE ON public.dashboard_settings TO authenticated;
GRANT ALL ON public.dashboard_settings TO service_role;

ALTER TABLE public.dashboard_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read dashboard settings"
ON public.dashboard_settings FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert dashboard settings"
ON public.dashboard_settings FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update dashboard settings"
ON public.dashboard_settings FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.dashboard_settings (id, reset_at) VALUES ('global', '1970-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;