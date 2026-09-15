
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS cpf text,
  ADD COLUMN IF NOT EXISTS data_nascimento date,
  ADD COLUMN IF NOT EXISTS pais text,
  ADD COLUMN IF NOT EXISTS verificado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS saldo_carteira numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saldo_bloqueado numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saldo_bonus numeric NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS players_external_id_uniq
  ON public.players(player_external_id)
  WHERE player_external_id IS NOT NULL;
