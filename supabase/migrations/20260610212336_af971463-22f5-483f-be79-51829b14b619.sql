CREATE INDEX IF NOT EXISTS players_tenant_ultimo_login_idx
  ON public.players (tenant_id, ultimo_login DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS players_tenant_total_dep_idx
  ON public.players (tenant_id, total_depositado DESC);

CREATE INDEX IF NOT EXISTS players_tenant_ultimo_deposito_idx
  ON public.players (tenant_id, ultimo_deposito DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS players_tenant_ftd_idx
  ON public.players (tenant_id, ftd_em);

CREATE INDEX IF NOT EXISTS players_tenant_vip_idx
  ON public.players (tenant_id, vip);

CREATE INDEX IF NOT EXISTS deposits_tenant_player_created_idx
  ON public.deposits (tenant_id, player_id, created_at DESC);