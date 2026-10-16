/* eslint-disable @typescript-eslint/no-explicit-any -- crm_results_daily precedes generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { aggregateCrmResults, type CrmResultRow } from "./crm-results";
import { resolveOperationalTenantId } from "./tenant-access.server";

const PAGE = 1000;
const MAX_PAGES = 50;
const ACCEPTED_SMS = ["sent", "delivered", "enviado", "entregue"];

const inputSchema = z.object({
  days: z.number().int().min(1).max(180).default(30),
});

/** BRT calendar date (YYYY-MM-DD) `offset` days before today. */
function brtDate(offset = 0) {
  return new Date(Date.now() - offset * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Central de Resultados: results of the tenant's journeys and campaigns in the
 * last `days` days (BRT), read from crm_results_daily (refreshed every 10 min).
 */
export const getCrmResults = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const from = brtDate(data.days - 1);
    const to = brtDate(0);

    // PostgREST caps every response at 1,000 rows: page explicitly.
    const rows: CrmResultRow[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data: chunk, error } = await db
        .from("crm_results_daily")
        .select(
          "metric_date,source_type,source_key,source_id,step_position,player_state,sent,failed,cost,recipients,human_clicks,direct_conversions,direct_revenue,influenced_players,influenced_deposits,influenced_revenue",
        )
        .eq("tenant_id", tenantId)
        .gte("metric_date", from)
        .lte("metric_date", to)
        .order("metric_date")
        .order("source_type")
        .order("source_key")
        .order("step_position")
        .order("player_state")
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error("Não foi possível carregar os resultados do CRM.");
      rows.push(...((chunk ?? []) as CrmResultRow[]));
      if (!chunk || chunk.length < PAGE) break;
    }

    const journeyIds = [
      ...new Set(
        rows
          .filter((row) => row.source_type === "journey" && row.source_id)
          .map((row) => String(row.source_id)),
      ),
    ];
    const names: Record<string, string> = {};
    if (journeyIds.length) {
      const { data: journeys } = await db
        .from("journeys")
        .select("id,name")
        .eq("tenant_id", tenantId)
        .in("id", journeyIds);
      for (const journey of (journeys ?? []) as Array<{ id: string; name: string }>)
        names[journey.id] = journey.name;
    }

    // Data health: freshness and a reconciliation of sends with the raw log.
    const fromInstant = new Date(`${from}T00:00:00-03:00`).toISOString();
    const [{ data: latest }, { count: rawSent }] = await Promise.all([
      db
        .from("crm_results_daily")
        .select("updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("sms_send_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ACCEPTED_SMS)
        .gte("created_at", fromInstant),
    ]);

    const result = aggregateCrmResults(rows, names);
    return {
      from,
      to,
      days: data.days,
      ...result,
      health: {
        updatedAt: (latest as { updated_at?: string } | null)?.updated_at ?? null,
        tableSent: result.totals.sent,
        rawSent: rawSent ?? null,
        truncated: rows.length >= PAGE * MAX_PAGES,
      },
    };
  });
