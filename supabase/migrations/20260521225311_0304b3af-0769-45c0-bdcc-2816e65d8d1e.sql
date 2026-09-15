
-- ai_logs: novas colunas
ALTER TABLE public.ai_logs
  ADD COLUMN IF NOT EXISTS intent_detectada text,
  ADD COLUMN IF NOT EXISTS origem_resposta text DEFAULT 'llm',
  ADD COLUMN IF NOT EXISTS audit jsonb DEFAULT '{}'::jsonb;

-- ai_feedback
CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_log_id uuid REFERENCES public.ai_logs(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('good','bad')),
  motivo text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ai_feedback" ON public.ai_feedback FOR SELECT USING (true);
CREATE POLICY "public write ai_feedback" ON public.ai_feedback FOR ALL USING (true) WITH CHECK (true);

-- ai_training_examples
CREATE TABLE IF NOT EXISTS public.ai_training_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pergunta text NOT NULL,
  resposta_ideal text NOT NULL,
  intent text,
  filtros jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  fonte text NOT NULL DEFAULT 'manual' CHECK (fonte IN ('manual','log','feedback')),
  ai_log_id uuid REFERENCES public.ai_logs(id) ON DELETE SET NULL,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_training_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ai_training_examples" ON public.ai_training_examples FOR SELECT USING (true);
CREATE POLICY "public write ai_training_examples" ON public.ai_training_examples FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_ai_training_examples_intent ON public.ai_training_examples(intent);
CREATE INDEX IF NOT EXISTS idx_ai_training_examples_ativo ON public.ai_training_examples(ativo);

-- ai_intents
CREATE TABLE IF NOT EXISTS public.ai_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,
  descricao text,
  palavras_chave text[] NOT NULL DEFAULT '{}'::text[],
  campo_alvo text,
  operador text,
  valor_padrao text,
  ordenacao jsonb NOT NULL DEFAULT '{}'::jsonb,
  limite_padrao integer NOT NULL DEFAULT 20,
  prioridade integer NOT NULL DEFAULT 100,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ai_intents" ON public.ai_intents FOR SELECT USING (true);
CREATE POLICY "public write ai_intents" ON public.ai_intents FOR ALL USING (true) WITH CHECK (true);

-- ai_synonyms
CREATE TABLE IF NOT EXISTS public.ai_synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  termo text NOT NULL,
  canonico text NOT NULL,
  tipo text NOT NULL DEFAULT 'geral' CHECK (tipo IN ('campo','expert','periodo','geral')),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_synonyms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ai_synonyms" ON public.ai_synonyms FOR SELECT USING (true);
CREATE POLICY "public write ai_synonyms" ON public.ai_synonyms FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_ai_synonyms_termo ON public.ai_synonyms(lower(termo));

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_ai_training_examples_updated ON public.ai_training_examples;
CREATE TRIGGER trg_ai_training_examples_updated BEFORE UPDATE ON public.ai_training_examples
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_intents_updated ON public.ai_intents;
CREATE TRIGGER trg_ai_intents_updated BEFORE UPDATE ON public.ai_intents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed intents iniciais
INSERT INTO public.ai_intents (nome, descricao, palavras_chave, campo_alvo, operador, ordenacao, limite_padrao, prioridade) VALUES
('players_with_balance', 'Players com saldo disponível na banca', ARRAY['banca','saldo','saldo atual','saldo disponivel','saldo disponível','dinheiro parado','dinheiro na conta','saldos da casa'], 'saldo_carteira', '>0', '{"campo":"saldo_carteira","ordem":"desc"}'::jsonb, 20, 10),
('deposito_hoje', 'Players que depositaram hoje', ARRAY['depositaram hoje','depositos hoje','depositantes hoje','depositou hoje'], 'ultimo_deposito', 'hoje', '{"campo":"total_depositado","ordem":"desc"}'::jsonb, 20, 20),
('ftd_hoje', 'Primeiros depósitos (FTD) de hoje', ARRAY['ftd hoje','primeiro deposito hoje','novos depositantes hoje'], 'ftd_em', 'hoje', '{"campo":"ftd_em","ordem":"desc"}'::jsonb, 20, 30),
('top_depositantes', 'Maiores depositantes', ARRAY['top depositantes','maiores depositantes','melhores depositantes','top 10 depositantes'], 'total_depositado', '>0', '{"campo":"total_depositado","ordem":"desc"}'::jsonb, 10, 40),
('vip', 'Players VIP', ARRAY['vip','vips'], 'vip', '=true', '{"campo":"total_depositado","ordem":"desc"}'::jsonb, 20, 50),
('inativos', 'Players inativos / sem jogar', ARRAY['sem jogar','inativo','inativos','nao jogam'], 'ultimo_jogo', '<', '{"campo":"ultimo_jogo","ordem":"asc"}'::jsonb, 20, 60),
('risco_abandono', 'Players em risco de abandono', ARRAY['risco','abandono','vao abandonar','em risco'], 'risco', '=alto', '{"campo":"total_depositado","ordem":"desc"}'::jsonb, 20, 70),
('cadastrou_nao_depositou', 'Players cadastrados que não depositaram', ARRAY['cadastrou e nao depositou','sem deposito','nao depositaram','cadastrados sem ftd'], 'ftd_em', 'is null', '{"campo":"created_at","ordem":"desc"}'::jsonb, 20, 80)
ON CONFLICT (nome) DO NOTHING;

-- Seed sinônimos
INSERT INTO public.ai_synonyms (termo, canonico, tipo) VALUES
('banca', 'saldo_carteira', 'campo'),
('saldo na conta', 'saldo_carteira', 'campo'),
('dinheiro parado', 'saldo_carteira', 'campo'),
('depositantes', 'total_depositado', 'campo'),
('sacadores', 'total_sacado', 'campo'),
('hoje', 'periodo:hoje', 'periodo'),
('ontem', 'periodo:ontem', 'periodo'),
('essa semana', 'periodo:semana', 'periodo'),
('esse mes', 'periodo:mes', 'periodo'),
('Queiroz', 'expert:Queiroz', 'expert'),
('queiroz', 'expert:Queiroz', 'expert'),
('Andrade', 'expert:Andrade', 'expert'),
('andrade', 'expert:Andrade', 'expert')
ON CONFLICT DO NOTHING;
