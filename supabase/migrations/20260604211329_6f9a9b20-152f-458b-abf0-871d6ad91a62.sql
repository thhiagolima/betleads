
-- Enum de gatilhos
DO $$ BEGIN
  CREATE TYPE public.email_trigger_type AS ENUM (
    'recuperacao_vip','lead_sem_login','lead_sem_deposito','primeiro_deposito',
    'pos_deposito','pos_saque','abandono_cadastro','abandono_deposito',
    'quase_vip','vip_inativo','cashback','cupom','conversao','retorno',
    'reativacao','manual','customizado'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.email_flow_block_type AS ENUM (
    'start','send_email','delay','condition','tag','remove','end'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.email_flow_lead_status AS ENUM (
    'pending','running','completed','exited','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1) email_flows
CREATE TABLE IF NOT EXISTS public.email_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_type public.email_trigger_type NOT NULL DEFAULT 'manual',
  active boolean NOT NULL DEFAULT false,
  daily_limit integer NOT NULL DEFAULT 1000,
  cooldown_hours integer NOT NULL DEFAULT 72,
  exit_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_flows TO authenticated;
GRANT ALL ON public.email_flows TO service_role;
ALTER TABLE public.email_flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_flows" ON public.email_flows
  TO authenticated USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_email_flows_updated_at BEFORE UPDATE ON public.email_flows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) email_flow_blocks
CREATE TABLE IF NOT EXISTS public.email_flow_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.email_flows(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  block_type public.email_flow_block_type NOT NULL,
  -- send_email
  template_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  sender_id uuid REFERENCES public.email_senders(id) ON DELETE SET NULL,
  smtp_config_id uuid REFERENCES public.email_smtp_configs(id) ON DELETE SET NULL,
  subject_override text,
  preheader_override text,
  pre_delay_seconds integer NOT NULL DEFAULT 0,
  -- delay
  delay_seconds integer NOT NULL DEFAULT 0,
  -- condition / tag
  condition_type text,
  condition_value text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_flow_blocks_flow_order
  ON public.email_flow_blocks(flow_id, order_index);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_flow_blocks TO authenticated;
GRANT ALL ON public.email_flow_blocks TO service_role;
ALTER TABLE public.email_flow_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_flow_blocks" ON public.email_flow_blocks
  TO authenticated USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 3) email_flow_leads
CREATE TABLE IF NOT EXISTS public.email_flow_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.email_flows(id) ON DELETE CASCADE,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  email text NOT NULL,
  status public.email_flow_lead_status NOT NULL DEFAULT 'pending',
  current_block_index integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_template_id uuid REFERENCES public.email_templates(id) ON DELETE SET NULL,
  exit_reason text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_flow_leads_run ON public.email_flow_leads(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_email_flow_leads_flow_player ON public.email_flow_leads(flow_id, player_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_flow_leads TO authenticated;
GRANT ALL ON public.email_flow_leads TO service_role;
ALTER TABLE public.email_flow_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_flow_leads" ON public.email_flow_leads
  TO authenticated USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_email_flow_leads_updated_at BEFORE UPDATE ON public.email_flow_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4) email_flow_logs
CREATE TABLE IF NOT EXISTS public.email_flow_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.email_flows(id) ON DELETE CASCADE,
  flow_lead_id uuid REFERENCES public.email_flow_leads(id) ON DELETE SET NULL,
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_flow_logs_flow ON public.email_flow_logs(flow_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_flow_logs TO authenticated;
GRANT ALL ON public.email_flow_logs TO service_role;
ALTER TABLE public.email_flow_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access email_flow_logs" ON public.email_flow_logs
  TO authenticated USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));
