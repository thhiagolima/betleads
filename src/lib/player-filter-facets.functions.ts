import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withServerResultCache } from "@/lib/server-result-cache";

export type PlayerFilterFacets = Record<string, number>;

export type PlayerFilterFacetInput = {
  gamificationStatus?: "active" | "cooling" | "sleeping" | "no_deposit" | null;
  gamificationLevel?: "bronze" | "silver" | "gold" | "diamond" | "black" | null;
};

/**
 * Contagens globais dos atalhos do painel de jogadores. Uma única RPC evita
 * que cada chip abra sua própria consulta de `count` no Postgres.
 */
export const getPlayerFilterFacets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: PlayerFilterFacetInput) => data)
  .handler(async ({ data, context }): Promise<PlayerFilterFacets> => {
    const supabase = context.supabase;
    const { data: tenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
    if (tenantError) throw new Error(tenantError.message);
    if (!tenantId) throw new Error("Conta atual não encontrada.");

    const status = data.gamificationStatus ?? null;
    const level = data.gamificationLevel ?? null;
    return withServerResultCache(
      `players:filter-facets:${tenantId}:${status ?? "all"}:${level ?? "all"}`,
      30_000,
      async () => {
        const { data, error } = await supabase.rpc("player_filter_facets_v1", {
          _tenant: tenantId,
          _gamification_status: status,
          _gamification_level: level,
        });
        if (error) throw new Error(error.message);
        return (data ?? {}) as PlayerFilterFacets;
      },
    );
  });
