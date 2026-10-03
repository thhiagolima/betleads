import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withServerResultCache } from "@/lib/server-result-cache";

export type PlayerFilterFacets = Record<string, number>;

export type PlayerFilterFacetInput = {
  behaviorFilters?: string[] | null;
  behaviorOperator?: "and" | "or" | null;
  gamificationStatus?: "active" | "cooling" | "sleeping" | "no_deposit" | null;
  gamificationLevel?: "bronze" | "silver" | "gold" | "diamond" | "black" | null;
  search?: string | null;
  dateField?: "created_at" | "ftd_em" | null;
  dateFrom?: string | null;
  dateTo?: string | null;
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
    const behaviorFilters = Array.from(new Set(data.behaviorFilters ?? [])).filter(Boolean);
    const behaviorOperator = data.behaviorOperator === "or" ? "or" : "and";
    const search = data.search?.trim() ?? "";
    const dateField = data.dateField ?? null;
    const dateFrom = data.dateFrom ?? null;
    const dateTo = data.dateTo ?? null;
    return withServerResultCache(
      `players:filter-facets:v2:${tenantId}:${behaviorFilters.join(",")}:${behaviorOperator}:${status ?? "all"}:${level ?? "all"}:${search}:${dateField ?? ""}:${dateFrom ?? ""}:${dateTo ?? ""}`,
      5_000,
      async () => {
        const { data, error } = await supabase.rpc("player_filter_contextual_facets_v1", {
          _tenant: tenantId,
          _filters: behaviorFilters,
          _operator: behaviorOperator,
          _gamification_status: status,
          _gamification_level: level,
          _search: search || null,
          _date_field: dateField,
          _date_from: dateFrom,
          _date_to: dateTo,
        });
        if (error) throw new Error(error.message);
        return (data ?? {}) as PlayerFilterFacets;
      },
    );
  });
