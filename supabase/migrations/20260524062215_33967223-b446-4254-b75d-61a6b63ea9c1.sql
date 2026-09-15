
-- ENUMS
CREATE TYPE public.flow_trigger_type AS ENUM (
  'recuperacao_vip','vip_esfriando','receita_em_queda','lead_quente_esfriando',
  'quase_vip','alto_potencial','reativacao_em_curso','jogador_em_momento',
  'janela_ideal','dinheiro_parado','engajado_sem_converter','frequencia_caindo'
);

CREATE TYPE public.flow_priority AS ENUM ('critico','alto','medio','baixo');

CREATE TYPE public.flow_block_type AS ENUM ('text','image','video','audio','document','delay');

CREATE TYPE public.flow_lead_status AS ENUM ('pending','running','completed','exited','failed','cooldown');

-- FLOWS
CREATE TABLE public.flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_type public.flow_trigger_type NOT NULL,
  priority public.flow_priority NOT NULL DEFAULT 'medio',
  active boolean NOT NULL DEFAULT true,
  delay_min_seconds integer NOT NULL DEFAULT 30,
  delay_max_seconds integer NOT NULL DEFAULT 120,
  cooldown_hours integer NOT NULL DEFAULT 48,
  daily_limit integer NOT NULL DEFAULT 200,
  hourly_limit integer NOT NULL DEFAULT 30,
  exit_conditions jsonb NOT NULL DEFAULT
    '{"login":true,"deposit":true,"bet":true,"whatsapp_reply":true,"human_takeover":true}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{"sent":0,"converted":0,"failed":0}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_flows_updated_at BEFORE UPDATE ON public.flows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access flows" ON public.flows
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- FLOW BLOCKS
CREATE TABLE public.flow_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  block_type public.flow_block_type NOT NULL,
  content text,
  caption text,
  media_url text,
  media_mimetype text,
  media_filename text,
  delay_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_flow_blocks_flow ON public.flow_blocks(flow_id, order_index);

ALTER TABLE public.flow_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access flow_blocks" ON public.flow_blocks
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- RULES (12 gatilhos do sistema)
CREATE TABLE public.rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type public.flow_trigger_type NOT NULL UNIQUE,
  name text NOT NULL,
  meaning text NOT NULL,
  priority public.flow_priority NOT NULL,
  flow_id uuid REFERENCES public.flows(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_match_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_rules_updated_at BEFORE UPDATE ON public.rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access rules" ON public.rules
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- FLOW LEADS (estado de execução)
CREATE TABLE public.flow_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  player_id uuid,
  phone_e164 text NOT NULL,
  session_id uuid,
  status public.flow_lead_status NOT NULL DEFAULT 'pending',
  current_block_index integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  exit_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0,
  UNIQUE(flow_id, phone_e164)
);
CREATE INDEX idx_flow_leads_due ON public.flow_leads(status, next_run_at) WHERE status IN ('pending','running');
CREATE INDEX idx_flow_leads_player ON public.flow_leads(player_id);
CREATE INDEX idx_flow_leads_phone ON public.flow_leads(phone_e164);

ALTER TABLE public.flow_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access flow_leads" ON public.flow_leads
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- FLOW LOGS
CREATE TABLE public.flow_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid REFERENCES public.flows(id) ON DELETE CASCADE,
  flow_lead_id uuid REFERENCES public.flow_leads(id) ON DELETE CASCADE,
  player_id uuid,
  block_id uuid REFERENCES public.flow_blocks(id) ON DELETE SET NULL,
  session_id uuid,
  event text NOT NULL, -- 'dispatched'|'sent'|'failed'|'exited'|'skipped'|'enqueued'
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_flow_logs_flow ON public.flow_logs(flow_id, created_at DESC);
CREATE INDEX idx_flow_logs_lead ON public.flow_logs(flow_lead_id, created_at DESC);

ALTER TABLE public.flow_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access flow_logs" ON public.flow_logs
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- LEAD ALERTS (dedupe + histórico)
CREATE TABLE public.lead_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL,
  trigger_type public.flow_trigger_type NOT NULL,
  rule_id uuid REFERENCES public.rules(id) ON DELETE SET NULL,
  flow_lead_id uuid REFERENCES public.flow_leads(id) ON DELETE SET NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_lead_alerts_player_trigger ON public.lead_alerts(player_id, trigger_type, fired_at DESC);

ALTER TABLE public.lead_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access lead_alerts" ON public.lead_alerts
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (has_role(auth.uid(),'admin'::app_role));

-- SEED das 12 regras
INSERT INTO public.rules (trigger_type, name, meaning, priority) VALUES
  ('recuperacao_vip',        'Recuperação VIP',         'VIP sem login há 7+ dias',                                   'critico'),
  ('vip_esfriando',          'VIP esfriando',           'VIP sem jogar há 2+ dias',                                   'alto'),
  ('receita_em_queda',       'Receita em queda',        'Depósitos caíram 50%+ vs período anterior (antes ≥ R$ 200)','alto'),
  ('lead_quente_esfriando',  'Lead quente esfriando',   'Depositava 5+ dias seguidos e parou há 3–7 dias',            'alto'),
  ('quase_vip',              'Quase VIP',               'Total depositado entre R$ 800 e R$ 999',                     'medio'),
  ('alto_potencial',         'Alto potencial',          '10+ logins, depósitos crescendo e login recente',            'medio'),
  ('reativacao_em_curso',    'Reativação em curso',     'Voltou a depositar após 14+ dias parado',                    'medio'),
  ('jogador_em_momento',     'Jogador em momento',      '5+ dias seguidos depositando e login nos últimos 2 dias',    'baixo'),
  ('janela_ideal',           'Janela ideal de contato', 'Joga frequentemente em horário padrão',                      'baixo'),
  ('dinheiro_parado',        'Dinheiro parado',         'Saldo ≥ R$ 50 e sem jogar há 5+ dias',                       'critico'),
  ('engajado_sem_converter', 'Engajado sem converter',  '8+ logins em 30 dias e sem depósito há 14+ dias',            'medio'),
  ('frequencia_caindo',      'Frequência de queda',     'Frequência de login caiu 50%+',                              'alto');
