
-- ============ SMS FLOWS ============
CREATE TABLE public.sms_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_name text,
  is_active boolean NOT NULL DEFAULT true,
  randomize_templates boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_flows TO authenticated;
GRANT ALL ON public.sms_flows TO service_role;
ALTER TABLE public.sms_flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access sms_flows" ON public.sms_flows
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_sms_flows_updated_at BEFORE UPDATE ON public.sms_flows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.sms_flow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.sms_flows(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  step_type text NOT NULL CHECK (step_type IN ('sms','delay')),
  content text,
  delay_days integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_flow_steps TO authenticated;
GRANT ALL ON public.sms_flow_steps TO service_role;
ALTER TABLE public.sms_flow_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access sms_flow_steps" ON public.sms_flow_steps
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX idx_sms_flow_steps_flow ON public.sms_flow_steps(flow_id, order_index);

-- ============ EMAIL SMTP ============
CREATE TABLE public.email_smtp_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 587,
  secure boolean NOT NULL DEFAULT false,
  username text,
  password_encrypted text,
  from_email text NOT NULL,
  from_name text,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'inactive',
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_smtp_configs TO authenticated;
GRANT ALL ON public.email_smtp_configs TO service_role;
ALTER TABLE public.email_smtp_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_smtp_configs" ON public.email_smtp_configs
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_email_smtp_updated_at BEFORE UPDATE ON public.email_smtp_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EMAIL TEMPLATES ============
CREATE TABLE public.email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text NOT NULL,
  body_html text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  preheader text,
  tags text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO authenticated;
GRANT ALL ON public.email_templates TO service_role;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_templates" ON public.email_templates
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_email_templates_updated_at BEFORE UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EMAIL CAMPAIGNS ============
CREATE TABLE public.email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  template_id uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  smtp_id uuid REFERENCES public.email_smtp_configs(id) ON DELETE SET NULL,
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft',
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_campaigns TO authenticated;
GRANT ALL ON public.email_campaigns TO service_role;
ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_campaigns" ON public.email_campaigns
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_email_campaigns_updated_at BEFORE UPDATE ON public.email_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EMAIL AUTOMATIONS ============
CREATE TABLE public.email_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_name text,
  template_id uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  smtp_id uuid REFERENCES public.email_smtp_configs(id) ON DELETE SET NULL,
  delay_minutes integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_automations TO authenticated;
GRANT ALL ON public.email_automations TO service_role;
ALTER TABLE public.email_automations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_automations" ON public.email_automations
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER trg_email_automations_updated_at BEFORE UPDATE ON public.email_automations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EMAIL SEND LOGS ============
CREATE TABLE public.email_send_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid,
  campaign_id uuid REFERENCES public.email_campaigns(id) ON DELETE SET NULL,
  automation_id uuid REFERENCES public.email_automations(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_send_logs TO authenticated;
GRANT ALL ON public.email_send_logs TO service_role;
ALTER TABLE public.email_send_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_send_logs" ON public.email_send_logs
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX idx_email_send_logs_created ON public.email_send_logs(created_at DESC);
