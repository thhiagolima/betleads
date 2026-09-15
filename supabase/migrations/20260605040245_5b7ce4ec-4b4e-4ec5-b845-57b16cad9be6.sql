
-- 1) automation_settings (singleton)
CREATE TABLE IF NOT EXISTS public.automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paused boolean NOT NULL DEFAULT false,
  sms_daily_limit integer NOT NULL DEFAULT 500,
  email_daily_limit integer NOT NULL DEFAULT 1000,
  call_daily_limit integer NOT NULL DEFAULT 200,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_settings TO authenticated;
GRANT ALL ON public.automation_settings TO service_role;
ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read automation_settings" ON public.automation_settings
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins update automation_settings" ON public.automation_settings
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins insert automation_settings" ON public.automation_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_automation_settings_updated_at BEFORE UPDATE ON public.automation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.automation_settings (paused) VALUES (false)
ON CONFLICT DO NOTHING;

-- 2) sms_flow_leads
DO $$ BEGIN
  CREATE TYPE public.sms_flow_lead_status AS ENUM ('pending','running','completed','exited','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.sms_flow_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.sms_flows(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  phone_e164 text NOT NULL,
  status public.sms_flow_lead_status NOT NULL DEFAULT 'pending',
  current_step_index integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  exit_reason text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_sms_flow_leads_run ON public.sms_flow_leads (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_sms_flow_leads_player ON public.sms_flow_leads (player_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_flow_leads TO authenticated;
GRANT ALL ON public.sms_flow_leads TO service_role;
ALTER TABLE public.sms_flow_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access sms_flow_leads" ON public.sms_flow_leads
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_sms_flow_leads_updated_at BEFORE UPDATE ON public.sms_flow_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) activation_runs
CREATE TABLE IF NOT EXISTS public.activation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('simulate','execute')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activation_runs_started ON public.activation_runs (started_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activation_runs TO authenticated;
GRANT ALL ON public.activation_runs TO service_role;
ALTER TABLE public.activation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access activation_runs" ON public.activation_runs
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
