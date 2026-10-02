import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withServerResultCache } from "@/lib/server-result-cache";

export type PlayerFilterFacets = Record<string, number>;

/**
 * Contagens globais dos atalhos do painel de jogadores. Uma única RPC evita
 * que cada chip abra sua própria consulta de `count` no Postgres.
 */
export const getPlayerFilterFacets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PlayerFilterFacets> => {
    const supabase = context.supabase;
    const { data: tenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
    if (tenantError) throw new Error(tenantError.message);
    if (!tenantId) throw new Error("Conta atual não encontrada.");

    return withServerResultCache(`players:filter-facets:${tenantId}`, 30_000, async () => {
      const { data, error } = await supabase.rpc("player_filter_facets_v1", {
        _tenant: tenantId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as PlayerFilterFacets;
    });
  });
