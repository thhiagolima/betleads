
-- Players table
CREATE TABLE public.players (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT,
  email TEXT,
  player_external_id TEXT,
  origem TEXT,
  expert TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  total_depositado NUMERIC NOT NULL DEFAULT 0,
  total_sacado NUMERIC NOT NULL DEFAULT 0,
  total_apostado NUMERIC NOT NULL DEFAULT 0,
  ultimo_login TIMESTAMPTZ,
  ultimo_jogo TIMESTAMPTZ,
  ultimo_deposito TIMESTAMPTZ,
  ultimo_saque TIMESTAMPTZ,
  ftd_em TIMESTAMPTZ,
  tags TEXT[] NOT NULL DEFAULT '{}',
  risco TEXT NOT NULL DEFAULT 'baixo',
  vip BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  valor NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.deposits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  valor NUMERIC NOT NULL,
  metodo TEXT,
  status TEXT NOT NULL DEFAULT 'aprovado',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.withdrawals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  valor NUMERIC NOT NULL,
  metodo TEXT,
  status TEXT NOT NULL DEFAULT 'aprovado',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em TIMESTAMPTZ,
  duracao_segundos INTEGER
);

CREATE TABLE public.ai_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pergunta TEXT NOT NULL,
  resposta TEXT,
  modelo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.webhook_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  evento TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'recebido',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.webhook_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  ultima_conexao TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_events_created_at ON public.events(created_at DESC);
CREATE INDEX idx_events_player ON public.events(player_id);
CREATE INDEX idx_players_status ON public.players(status);
CREATE INDEX idx_players_ultimo_login ON public.players(ultimo_login DESC);

-- RLS (permissive for demo / internal tool)
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read players" ON public.players FOR SELECT USING (true);
CREATE POLICY "public write players" ON public.players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read events" ON public.events FOR SELECT USING (true);
CREATE POLICY "public write events" ON public.events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read deposits" ON public.deposits FOR SELECT USING (true);
CREATE POLICY "public write deposits" ON public.deposits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read withdrawals" ON public.withdrawals FOR SELECT USING (true);
CREATE POLICY "public write withdrawals" ON public.withdrawals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read sessions" ON public.sessions FOR SELECT USING (true);
CREATE POLICY "public write sessions" ON public.sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read ai_logs" ON public.ai_logs FOR SELECT USING (true);
CREATE POLICY "public write ai_logs" ON public.ai_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read webhook_logs" ON public.webhook_logs FOR SELECT USING (true);
CREATE POLICY "public write webhook_logs" ON public.webhook_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public read webhook_configs" ON public.webhook_configs FOR SELECT USING (true);
CREATE POLICY "public write webhook_configs" ON public.webhook_configs FOR ALL USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.players;
ALTER PUBLICATION supabase_realtime ADD TABLE public.webhook_logs;
