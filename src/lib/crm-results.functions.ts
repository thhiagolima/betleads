/* eslint-disable @typescript-eslint/no-explicit-any -- crm_results_daily precedes generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { aggregateCrmResults, compareHoldout, type CrmResultRow } from "./crm-results";
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

    // F3: treated x control per journey (entries whose 7-day window closed).
    const { data: holdoutRows } = await db.rpc("journey_holdout_results", {
      _tenant: tenantId,
      _from: fromInstant,
      _to: new Date().toISOString(),
      _window_days: 7,
    });
    const groups = new Map<
      string,
      Record<"treated" | "control", { players: number; returned: number; revenue: number }>
    >();
    for (const row of (holdoutRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.journey_id);
      const entry = groups.get(id) ?? {
        treated: { players: 0, returned: 0, revenue: 0 },
        control: { players: 0, returned: 0, revenue: 0 },
      };
      entry[row.is_holdout ? "control" : "treated"] = {
        players: Number(row.players ?? 0),
        returned: Number(row.returned ?? 0),
        revenue: Number(row.revenue ?? 0),
      };
      groups.set(id, entry);
    }
    const missing = [...groups.keys()].filter((id) => !names[id]);
    if (missing.length) {
      const { data: extra } = await db
        .from("journeys")
        .select("id,name")
        .eq("tenant_id", tenantId)
        .in("id", missing);
      for (const journey of (extra ?? []) as Array<{ id: string; name: string }>)
        names[journey.id] = journey.name;
    }
    const holdout = [...groups.entries()].map(([journeyId, entry]) => ({
      journeyId,
      name: names[journeyId] ?? "Jornada",
      treated: entry.treated,
      control: entry.control,
      ...compareHoldout(entry.treated, entry.control),
    }));

    const result = aggregateCrmResults(rows, names);
    return {
      from,
      to,
      days: data.days,
      ...result,
      holdout,
      health: {
        updatedAt: (latest as { updated_at?: string } | null)?.updated_at ?? null,
        tableSent: result.totals.sent,
        rawSent: rawSent ?? null,
        truncated: rows.length >= PAGE * MAX_PAGES,
      },
    };
  });

/**
 * Central de Resultados F4: weekly retention cohorts, the acquisition funnel of
 * the period's sign-ups and where the base is now.
 */
export const getCrmRetention = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => inputSchema.parse(value ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const from = brtDate(data.days - 1);
    const fromInstant = new Date(`${from}T00:00:00-03:00`).toISOString();
    const [cohorts, funnel, lifecycle] = await Promise.all([
      db.rpc("crm_retention_cohorts", { _tenant: tenantId, _weeks: 12 }),
      db.rpc("crm_acquisition_funnel", {
        _tenant: tenantId,
        _from: fromInstant,
        _to: new Date().toISOString(),
      }),
      db.rpc("crm_lifecycle_snapshot", { _tenant: tenantId }),
    ]);
    for (const result of [cohorts, funnel, lifecycle])
      if (result.error) throw new Error("Não foi possível carregar retenção e aquisição.");
    const toNumber = (value: unknown) => (value == null ? null : Number(value));
    const funnelRows = ((funnel.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      origin: String(row.origin),
      signups: Number(row.signups ?? 0),
      firstDeposit: Number(row.first_deposit ?? 0),
      secondDeposit: Number(row.second_deposit ?? 0),
      thirdPlus: Number(row.third_plus ?? 0),
      medianHoursToFtd: toNumber(row.median_hours_to_ftd),
    }));
    return {
      from,
      cohorts: ((cohorts.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        week: String(row.cohort_week),
        size: Number(row.cohort_size ?? 0),
        second7d: toNumber(row.second_7d_pct),
        second14d: toNumber(row.second_14d_pct),
        second30d: toNumber(row.second_30d_pct),
        medianHoursToSecond: toNumber(row.median_hours_to_second),
        revenue30d: toNumber(row.revenue_30d),
      })),
      funnel: {
        total: funnelRows.find((row) => row.origin === "__total__") ?? null,
        byOrigin: funnelRows
          .filter((row) => row.origin !== "__total__")
          .sort((a, b) => b.signups - a.signups),
      },
      lifecycle: ((lifecycle.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        state: String(row.state),
        players: Number(row.players ?? 0),
      })),
    };
  });
