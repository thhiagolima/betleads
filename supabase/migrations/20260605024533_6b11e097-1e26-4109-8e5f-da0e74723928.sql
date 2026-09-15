CREATE TABLE public.send_window_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  start_minute int NOT NULL DEFAULT 360,
  end_minute int NOT NULL DEFAULT 1320,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  weekdays int[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.send_window_settings TO authenticated;
GRANT ALL ON public.send_window_settings TO service_role;

ALTER TABLE public.send_window_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read send window"
  ON public.send_window_settings FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can update send window"
  ON public.send_window_settings FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated can insert send window"
  ON public.send_window_settings FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE TRIGGER send_window_settings_set_updated_at
  BEFORE UPDATE ON public.send_window_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.send_window_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
