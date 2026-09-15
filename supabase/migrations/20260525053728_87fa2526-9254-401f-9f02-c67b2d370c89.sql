
-- Enums
CREATE TYPE public.call_flow_sms_mode AS ENUM ('none', 'always', 'answered', 'not_answered', 'listened_seconds');

-- call_flows
CREATE TABLE public.call_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_name text,
  is_active boolean NOT NULL DEFAULT true,
  randomize_scripts boolean NOT NULL DEFAULT true,
  avoid_last_script boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.call_flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flows" ON public.call_flows
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER set_updated_at_call_flows BEFORE UPDATE ON public.call_flows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- call_flow_scripts
CREATE TABLE public.call_flow_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.call_flows(id) ON DELETE CASCADE,
  script_id uuid NOT NULL REFERENCES public.call_scripts(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_flow_scripts_flow ON public.call_flow_scripts(flow_id);
ALTER TABLE public.call_flow_scripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_scripts" ON public.call_flow_scripts
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- call_flow_post_action
CREATE TABLE public.call_flow_post_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL UNIQUE REFERENCES public.call_flows(id) ON DELETE CASCADE,
  sms_mode public.call_flow_sms_mode NOT NULL DEFAULT 'none',
  min_listened_seconds integer NOT NULL DEFAULT 5,
  sms_template text NOT NULL DEFAULT '',
  delay_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.call_flow_post_action ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_post_action" ON public.call_flow_post_action
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE TRIGGER set_updated_at_call_flow_post_action BEFORE UPDATE ON public.call_flow_post_action
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- call_flow_executions
CREATE TABLE public.call_flow_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.call_flows(id) ON DELETE CASCADE,
  lead_id uuid,
  script_id uuid REFERENCES public.call_scripts(id) ON DELETE SET NULL,
  call_queue_id uuid,
  status text NOT NULL DEFAULT 'pending',
  sms_sent boolean NOT NULL DEFAULT false,
  sms_origin text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_flow_executions_flow ON public.call_flow_executions(flow_id);
CREATE INDEX idx_call_flow_executions_lead ON public.call_flow_executions(lead_id);
ALTER TABLE public.call_flow_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access call_flow_executions" ON public.call_flow_executions
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
