DROP INDEX IF EXISTS public.players_external_id_uniq;
CREATE UNIQUE INDEX players_external_id_uniq ON public.players(player_external_id);