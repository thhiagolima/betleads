// Área do Expert — "Início" com a mesma cara do Início da casa (cartões,
// gráfico de depósitos e saques, Recuperado e Ao vivo), mas só com os
// números dos leads do próprio expert.
//
// O recorte é sempre resolvido aqui no servidor por `requireExpertContext`
// (casa, tipo e affiliate_ids do expert logado), nunca vindo do navegador:
//   - tipo 'total'    -> `_affiliate_ids` null = todos os jogadores da casa;
//   - tipo 'restrito' -> só players.affiliate_id dos affiliate_ids dele;
//     sem nenhum affiliate_id vinculado, tudo zero sem consultar o banco.
// A função SQL `expert_home_summary` (20261216100000_expert_home_summary.sql)
// é service_role e ainda está fora dos tipos gerados -> `(supabaseAdmin as
// any)`, como em `expert-metrics.functions.ts`. Período, período anterior,
// cache e timeout são os mesmos do Início da casa (`dashboard.functions.ts`).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DASHBOARD_REQUEST_TIMEOUT_MS,
  dashboardPeriodBounds,
  mapLeadScopedDashboardRpc,
  withTimeout,
  type DashboardRpc,
  type LeadScopedDashboard,
} from "@/lib/dashboard.functions";
import { requireExpertContext } from "@/lib/expert-access.server";
import { withServerResultCache } from "@/lib/server-result-cache";

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

const inputSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// RPC/tabela fora dos tipos gerados (ver cabeçalho).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

export type ExpertHomeSummary = LeadScopedDashboard;

/** Maps the raw `expert_home_summary` payload (same keys as the house, minus house-only ones). */
export function mapExpertHomeRpc(value: DashboardRpc, periodDays: number): ExpertHomeSummary {
  return mapLeadScopedDashboardRpc(value, periodDays);
}

/** The home of a restrito expert with no affiliate id: every number zero, empty series/feed. */
export function zeroExpertHomeSummary(periodDays: number): ExpertHomeSummary {
  return mapLeadScopedDashboardRpc({}, periodDays);
}

export const getExpertHomeSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data, context }) =>
    getExpertHomeSummaryFor(context as unknown as ServerContext, data),
  );

/** Body of `getExpertHomeSummary`, exported so it is directly unit-testable. */
export async function getExpertHomeSummaryFor(
  ctx: ServerContext,
  data: z.input<typeof inputSchema>,
): Promise<ExpertHomeSummary> {
  const input = inputSchema.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const { startDate, endDate, periodDays, prevFrom, prevTo, ttlMs } = dashboardPeriodBounds(
    input.from,
    input.to,
  );

  // Restrito sem affiliate_id nenhum vinculado -> nada a ver, sem consultar.
  if (expert.tipo === "restrito" && expert.affiliateIds.length === 0) {
    return zeroExpertHomeSummary(periodDays);
  }
  const affiliateIds = expert.tipo === "total" ? null : [...expert.affiliateIds].sort();

  const cacheKey = [
    "expert-home",
    expert.tenantId,
    expert.expertId,
    affiliateIds ? affiliateIds.join(",") : "*",
    startDate.toISOString(),
    endDate.toISOString(),
  ].join(":");

  return withServerResultCache(cacheKey, ttlMs, () =>
    withTimeout(
      (async () => {
        const { data: settings, error: settingsError } = await db()
          .from("dashboard_settings")
          .select("reset_at")
          .eq("tenant_id", expert.tenantId)
          .eq("id", "global")
          .maybeSingle();
        if (settingsError) throw new Error(settingsError.message);

        const { data: raw, error } = await db().rpc("expert_home_summary", {
          _tenant: expert.tenantId,
          _affiliate_ids: affiliateIds,
          _from: startDate.toISOString(),
          _to: endDate.toISOString(),
          _prev_from: prevFrom,
          _prev_to: prevTo,
          _reset_at:
            (settings as { reset_at?: string | null } | null)?.reset_at ?? "1970-01-01T00:00:00Z",
        });
        if (error) throw new Error(error.message);

        return mapExpertHomeRpc((raw ?? {}) as DashboardRpc, periodDays);
      })(),
      DASHBOARD_REQUEST_TIMEOUT_MS,
      "O painel demorou mais que o esperado para responder. Tente novamente.",
    ),
  );
}
