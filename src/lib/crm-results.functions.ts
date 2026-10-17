/* eslint-disable @typescript-eslint/no-explicit-any -- crm_results_daily precedes generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  aggregateCrmResults,
  compareHoldout,
  stepLabels,
  type CrmResultRow,
  type JourneyStepInfo,
} from "./crm-results";
import { resolveOperationalTenantId } from "./tenant-access.server";

const PAGE = 1000;
const MAX_PAGES = 50;
const ACCEPTED_SMS = ["sent", "delivered", "enviado", "entregue"];

const inputSchema = z.object({
  days: z.number().int().min(1).max(180).default(30),
  // Days between today and the last day of the period: 1 = ends yesterday.
  endOffset: z.number().int().min(0).max(1).default(0),
});

/** BRT calendar date (YYYY-MM-DD) `offset` days before today. */
function brtDate(offset = 0) {
  return new Date(Date.now() - offset * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * BRT days of the period: `days` days ending `endOffset` days before today.
 * The instants cover whole days, never past now.
 */
function periodBounds(days: number, endOffset: number) {
  const from = brtDate(endOffset + days - 1);
  const to = brtDate(endOffset);
  const dayAfter = new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000);
  return {
    from,
    to,
    fromInstant: new Date(`${from}T00:00:00-03:00`).toISOString(),
    toInstant: new Date(Math.min(Date.now(), dayAfter.getTime() - 1)).toISOString(),
  };
}

const RESULT_COLUMNS =
  "metric_date,source_type,source_key,source_id,step_position,player_state,sent,failed,cost,recipients,human_clicks,direct_conversions,direct_players,direct_revenue,influenced_players,influenced_deposits,influenced_revenue";

/** crm_results_daily rows of one tenant between two BRT dates; PostgREST caps at 1,000 per page. */
async function loadResultRows(db: any, tenantId: string, from: string, to: string) {
  const rows: CrmResultRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data: chunk, error } = await db
      .from("crm_results_daily")
      .select(RESULT_COLUMNS)
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
  return rows;
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
    const { from, to, fromInstant, toInstant } = periodBounds(data.days, data.endOffset);

    // Same-length period right before this one, for the variation on each KPI.
    const previous = periodBounds(data.days, data.endOffset + data.days);
    const [rows, previousRows] = await Promise.all([
      loadResultRows(db, tenantId, from, to),
      loadResultRows(db, tenantId, previous.from, previous.to),
    ]);

    const journeyIds = [
      ...new Set(
        rows
          .filter((row) => row.source_type === "journey" && row.source_id)
          .map((row) => String(row.source_id)),
      ),
    ];
    const names: Record<string, string> = {};
    // Readable step names per journey: "2ª mensagem · +2 dias".
    const steps: Record<string, Record<number, string>> = {};
    if (journeyIds.length) {
      const [{ data: journeys }, { data: journeySteps }] = await Promise.all([
        db.from("journeys").select("id,name").eq("tenant_id", tenantId).in("id", journeyIds),
        db
          .from("journey_steps")
          .select("journey_id,position,step_type,is_enabled,config")
          .eq("tenant_id", tenantId)
          .in("journey_id", journeyIds),
      ]);
      for (const journey of (journeys ?? []) as Array<{ id: string; name: string }>)
        names[journey.id] = journey.name;
      const byJourney = new Map<string, JourneyStepInfo[]>();
      for (const step of (journeySteps ?? []) as Array<JourneyStepInfo & { journey_id: string }>)
        byJourney.set(step.journey_id, [...(byJourney.get(step.journey_id) ?? []), step]);
      for (const [journeyId, list] of byJourney) steps[journeyId] = stepLabels(list);
    }

    // Data health: freshness and a reconciliation of sends with the raw log.
    const [{ data: latest }, { count: rawSent }, { data: checks }] = await Promise.all([
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
        .gte("created_at", fromInstant)
        .lte("created_at", toInstant),
      db
        .from("crm_results_health")
        .select("metric_date,check_name,expected,actual,ok,checked_at")
        .eq("tenant_id", tenantId)
        .gte("metric_date", brtDate(14))
        .order("metric_date", { ascending: false })
        .limit(60),
    ]);

    // F3: treated x control per journey (entries whose 7-day window closed).
    const { data: holdoutRows } = await db.rpc("journey_holdout_results", {
      _tenant: tenantId,
      _from: fromInstant,
      _to: toInstant,
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

    // Journeys with a control group and how far each test is: entries so far in
    // each group, and when the first 7-day window closes.
    const { data: holdoutJourneys } = await db
      .from("journeys")
      .select("id,name,status,holdout_percent")
      .eq("tenant_id", tenantId)
      .gt("holdout_percent", 0)
      .order("name");
    const holdoutSetup = await Promise.all(
      (
        (holdoutJourneys ?? []) as Array<{
          id: string;
          name: string;
          status: string;
          holdout_percent: number;
        }>
      ).map(async (journey) => {
        const count = (isHoldout: boolean) =>
          db
            .from("journey_enrollments")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .eq("journey_id", journey.id)
            .eq("is_holdout", isHoldout)
            .gte("entered_at", fromInstant)
            .lte("entered_at", toInstant);
        const [{ count: control }, { count: treated }, { data: first }] = await Promise.all([
          count(true),
          count(false),
          db
            .from("journey_enrollments")
            .select("entered_at")
            .eq("tenant_id", tenantId)
            .eq("journey_id", journey.id)
            .eq("is_holdout", true)
            .order("entered_at")
            .limit(1)
            .maybeSingle(),
        ]);
        const firstEntry = (first as { entered_at?: string } | null)?.entered_at ?? null;
        return {
          journeyId: journey.id,
          name: journey.name,
          status: journey.status,
          percent: Number(journey.holdout_percent),
          control: control ?? 0,
          treated: treated ?? 0,
          firstResultAt: firstEntry
            ? new Date(new Date(firstEntry).getTime() + 7 * 86_400_000).toISOString()
            : null,
        };
      }),
    );

    const result = aggregateCrmResults(rows, names);
    return {
      from,
      to,
      days: data.days,
      endOffset: data.endOffset,
      previous: {
        from: previous.from,
        to: previous.to,
        totals: previousRows.length ? aggregateCrmResults(previousRows).totals : null,
      },
      stepNames: steps,
      ...result,
      holdout,
      holdoutSetup,
      health: {
        updatedAt: (latest as { updated_at?: string } | null)?.updated_at ?? null,
        tableSent: result.totals.sent,
        rawSent: rawSent ?? null,
        truncated: rows.length >= PAGE * MAX_PAGES,
        checks: ((checks ?? []) as Array<Record<string, unknown>>).map((row) => ({
          date: String(row.metric_date),
          name: String(row.check_name),
          expected: Number(row.expected ?? 0),
          actual: Number(row.actual ?? 0),
          ok: Boolean(row.ok),
        })),
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
    const { from, to, fromInstant, toInstant } = periodBounds(data.days, data.endOffset);
    const [cohorts, funnel, lifecycle, lifecycleDaily] = await Promise.all([
      db.rpc("crm_retention_cohorts", { _tenant: tenantId, _weeks: 12 }),
      db.rpc("crm_acquisition_funnel", {
        _tenant: tenantId,
        _from: fromInstant,
        _to: toInstant,
      }),
      db.rpc("crm_lifecycle_snapshot", { _tenant: tenantId }),
      db
        .from("player_lifecycle_daily")
        .select("metric_date,state,players")
        .eq("tenant_id", tenantId)
        .gte("metric_date", from)
        .lte("metric_date", to)
        .order("metric_date")
        .limit(1000),
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
      // One point per day with the players in each state at the end of the day.
      lifecycleDaily: Object.values(
        (
          (lifecycleDaily.data ?? []) as Array<{
            metric_date: string;
            state: string;
            players: number;
          }>
        ).reduce<Record<string, Record<string, number | string>>>((days, row) => {
          days[row.metric_date] ??= { date: row.metric_date };
          days[row.metric_date][row.state] = Number(row.players ?? 0);
          return days;
        }, {}),
      ) as Array<{ date: string } & Record<string, number | string>>,
    };
  });
