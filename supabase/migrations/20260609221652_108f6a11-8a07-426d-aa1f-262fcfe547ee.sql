ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_external_id_uniq;
DROP INDEX IF EXISTS public.players_external_id_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS players_tenant_external_id_uniq
  ON public.players (tenant_id, player_external_id)
  WHERE player_external_id IS NOT NULL;