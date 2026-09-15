CREATE TABLE public.antiban_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  delay_min_seconds integer NOT NULL DEFAULT 180,
  delay_max_seconds integer NOT NULL DEFAULT 720,
  hourly_limit integer NOT NULL DEFAULT 40,
  daily_limit integer NOT NULL DEFAULT 400,
  window_start time NOT NULL DEFAULT '08:00',
  window_end time NOT NULL DEFAULT '22:00',
  randomization_enabled boolean NOT NULL DEFAULT true,
  smart_suppression_enabled boolean NOT NULL DEFAULT true,
  auto_pause_enabled boolean NOT NULL DEFAULT true,
  warmup_enabled boolean NOT NULL DEFAULT true,
  warmup_initial_daily integer NOT NULL DEFAULT 50,
  warmup_days integer NOT NULL DEFAULT 7,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.antiban_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access antiban_settings"
ON public.antiban_settings FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER antiban_settings_set_updated_at
BEFORE UPDATE ON public.antiban_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.antiban_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;