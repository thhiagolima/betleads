
CREATE TABLE public.experts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.experts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read experts" ON public.experts FOR SELECT USING (true);
CREATE POLICY "public write experts" ON public.experts FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.players ADD COLUMN IF NOT EXISTS affiliate_id TEXT;
CREATE INDEX IF NOT EXISTS idx_players_affiliate_id ON public.players(affiliate_id);

INSERT INTO public.experts (affiliate_id, nome) VALUES
  ('69cde3d75779177c6fed3c7c', 'Queiroz'),
  ('69ad88a944290ad64e25c737', 'Queiroz'),
  ('69cb55b159dc0d386aee4290', 'Andrade'),
  ('696ac80b49538ecc55b0d72c', 'Andrade')
ON CONFLICT (affiliate_id) DO UPDATE SET nome = EXCLUDED.nome;
