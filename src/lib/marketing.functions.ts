import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import {
  buildMarketingOverview,
  parseOverviewPeriod,
  type MarketingOverviewRpc,
} from "@/lib/marketing-overview";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";

const overviewSchema = z.object({
  from: z.string().trim(),
  to: z.string().trim(),
});

type Integration = {
  id: string;
  provider: "meta" | "windsor" | "csv";
  status: string;
  account_name: string | null;
  external_account_id: string | null;
  currency: string;
  last_sync_at: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
  settings: Record<string, Json>;
};

type DbError = { message: string } | null;
type DbClient = {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: DbError }>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        order: (column: string) => Promise<{ data: unknown; error: DbError }>;
      };
    };
  };
};

async function resolveTenantId(supabase: DbClient): Promise<string> {
  return resolveCurrentTenantId(supabase);
}

// Todos os números vêm de public.marketing_overview (AL1-01): totais sobre todas as
// linhas, dia de Brasília, ROAS sobre o líquido e CAC só sobre jogadores pagos.
export const getMarketingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => {
    const parsed = overviewSchema.parse(input ?? {});
    return parseOverviewPeriod(parsed.from, parsed.to);
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveTenantId(db);

    const [overviewRes, integrationsRes] = await Promise.all([
      db.rpc("marketing_overview", { _tenant: tenantId, _from: data.from, _to: data.to }),
      db
        .from("marketing_integrations")
        .select(
          "id, provider, status, account_name, external_account_id, currency, last_sync_at, token_expires_at, connected_at, settings",
        )
        .eq("tenant_id", tenantId)
        .order("provider"),
    ]);
    if (overviewRes.error) throw new Error(overviewRes.error.message);
    if (integrationsRes.error) throw new Error(integrationsRes.error.message);

    return {
      tenantId,
      ...buildMarketingOverview(overviewRes.data as MarketingOverviewRpc),
      integrations: (integrationsRes.data ?? []) as Integration[],
    };
  });
