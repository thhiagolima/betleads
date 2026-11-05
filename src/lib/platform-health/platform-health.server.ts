// Super-admin "Saúde" console (F1, spec §5.2–5.4): server-side loader.
//
// `adminPlatformHealthFor` fetches every source in parallel (houses, 35 days
// of finance/activity data, job health, queue metrics, provider breakers/rate
// state, Short.io sync runs, billing runway candidates, billing health and
// per-house webhook stats), turns them into `HouseHealthRow[]` (house-health.ts)
// and `PlatformAlert[]` (alert-rules.ts), and caches the result for 60 s so
// the panel polling doesn't hammer every source on every request.
//
// Every source is read through `fromSource`: on error or timeout it logs,
// adds a `sourceFailureAlert(name)` to the result and falls back to an empty
// value, so one bad source never breaks the whole panel.

import { DEFAULT_CURRENCY } from "@/lib/currency";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertSuperAdmin, checkBillingHealth } from "@/lib/billing/billing-health.server";
import type { ActivityDayRow, FinanceDayRow } from "@/lib/finance/finance-data.server";
import {
  fetchActivityDays,
  fetchFinanceDays,
  todaySaoPaulo,
} from "@/lib/finance/finance-data.server";

import {
  billingAlerts,
  jobAlerts,
  providerAlerts,
  queueAlerts,
  runwayAlerts,
  sortAlerts,
  sourceFailureAlert,
  webhookAlerts,
  type BreakerRow,
  type JobHealthRow,
  type PlatformAlert,
  type QueueMetricRow,
  type RateStateRow,
  type RunwayRow,
  type ShortioRunRow,
  type WebhookStats,
} from "./alert-rules";
import {
  healthWindows,
  sortHouses,
  summarizeHouse,
  type HealthWindows,
  type HouseDay,
  type HouseHealthInput,
  type HouseHealthRow,
} from "./house-health";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- observability RPCs are not in the generated Supabase types.
type LooseDb = any;

const db = () => supabaseAdmin as LooseDb;

export type PlatformHealth = {
  checkedAt: string;
  window: HealthWindows["current"];
  alerts: PlatformAlert[];
  houses: HouseHealthRow[];
  quietHouses: Array<{ tenantId: string; name: string }>;
};

type HouseTenantRow = {
  id: string;
  nome: string;
  moeda: string | null;
  status: string;
  is_demo: boolean;
};

const CACHE_MS = 60_000;
let cache: { at: number; value: PlatformHealth } | null = null;

/** Test hook: forget the cached result so the next call fetches fresh. */
export function __resetPlatformHealthCacheForTests(): void {
  cache = null;
}

const DEFAULT_TIMEOUT_MS = 8000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * The last ≤200 `webhook_logs.created_at` of the past 7 days (newest first)
 * estimate a house's daily event rate: `n / 7` while under the 200-row
 * sample, else `200 / (newest − oldest in days)` (a 7-day exact count is too
 * slow for the biggest houses — see Step 0 of the brief).
 */
export function estimateEventsPerDay(createdAtDesc: string[], now: Date): number {
  void now;
  const n = createdAtDesc.length;
  if (n === 0) return 0;
  if (n < 200) return n / 7;
  const newest = new Date(createdAtDesc[0]).getTime();
  const oldest = new Date(createdAtDesc[n - 1]).getTime();
  // Guard against a zero (or negative, out-of-order) span: floor it to one
  // minute so the estimate stays a large-but-finite number instead of Infinity.
  const spanDays = Math.max((newest - oldest) / 86_400_000, 1 / 1440);
  return 200 / spanDays;
}

async function runLimited<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function fetchHouseTenants(): Promise<HouseTenantRow[]> {
  const { data, error } = await db()
    .from("tenants")
    .select("id,nome,moeda,status,is_demo")
    .eq("is_demo", false)
    .neq("status", "canceled");
  if (error) throw new Error(errorText(error));
  return (data ?? []) as HouseTenantRow[];
}

async function fetchObservabilityRpc<T>(fn: string): Promise<T[]> {
  const { data, error } = await db().rpc(fn);
  if (error) throw new Error(errorText(error));
  return (data ?? []) as T[];
}

async function fetchBreakers(): Promise<BreakerRow[]> {
  const { data, error } = await db()
    .from("provider_circuit_breakers")
    .select("channel,state,reason,first_opened_at");
  if (error) throw new Error(errorText(error));
  return (data ?? []) as BreakerRow[];
}

async function fetchRateStates(): Promise<RateStateRow[]> {
  const { data, error } = await db()
    .from("dispatch_rate_state")
    .select("channel,last_provider_error,backoff_until");
  if (error) throw new Error(errorText(error));
  return (data ?? []) as RateStateRow[];
}

async function fetchShortioRuns(): Promise<ShortioRunRow[]> {
  const { data, error } = await db()
    .from("dispatcher_runs")
    .select("started_at,claimed,rate_limited")
    .eq("job", "shortio_sync")
    .order("started_at", { ascending: false })
    .limit(6);
  if (error) throw new Error(errorText(error));
  return (data ?? []) as ShortioRunRow[];
}

async function fetchRunwayCandidates(): Promise<RunwayRow[]> {
  const { data, error } = await db().rpc("billing_runway_alert_candidates", {
    _after: null,
    _limit: 500,
    _hours: 24,
  });
  if (error) throw new Error(errorText(error));
  return (data ?? []) as RunwayRow[];
}

const WEBHOOK_SAMPLE_DAYS = 7;
const WEBHOOK_SAMPLE_LIMIT = 200;
const WEBHOOK_STATS_CONCURRENCY = 4;

/**
 * Per house: the last ≤200 `webhook_logs` of the past 7 days (index-only
 * scan) and the 24 h `status = 'erro'` count (exact head count, served by
 * `webhook_logs_tenant_status_created_idx`) — see `estimateEventsPerDay`.
 */
async function fetchWebhookStats(houses: HouseTenantRow[], now: Date): Promise<WebhookStats[]> {
  const sevenDaysAgo = new Date(now.getTime() - WEBHOOK_SAMPLE_DAYS * 86_400_000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const stats: WebhookStats[] = [];
  await runLimited(houses, WEBHOOK_STATS_CONCURRENCY, async (house) => {
    const [events, errors] = await Promise.all([
      db()
        .from("webhook_logs")
        .select("created_at")
        .eq("tenant_id", house.id)
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(WEBHOOK_SAMPLE_LIMIT),
      db()
        .from("webhook_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", house.id)
        .eq("status", "erro")
        .gte("created_at", since24h),
    ]);
    if (events.error) throw new Error(errorText(events.error));
    if (errors.error) throw new Error(errorText(errors.error));
    const createdAtDesc = ((events.data ?? []) as Array<{ created_at: string }>).map(
      (r) => r.created_at,
    );
    stats.push({
      tenantId: house.id,
      name: house.nome,
      lastEventAt: createdAtDesc[0] ?? null,
      eventsPerDay: estimateEventsPerDay(createdAtDesc, now),
      errors24h: errors.count ?? 0,
    });
  });
  return stats;
}

function groupByTenant<T extends { tenant_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.tenant_id);
    if (list) list.push(row);
    else map.set(row.tenant_id, [row]);
  }
  return map;
}

/** Merges a house's finance and activity rows into the 35-day history `summarizeHouse` wants. */
function buildHouseDays(financeRows: FinanceDayRow[], activityRows: ActivityDayRow[]): HouseDay[] {
  const byDate = new Map<string, HouseDay>();
  const dayFor = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created: HouseDay = { date, registrations: 0, ftds: 0, recovered: 0 };
    byDate.set(date, created);
    return created;
  };
  for (const row of financeRows) {
    const day = dayFor(row.metric_date);
    day.registrations = Number(row.registrations ?? 0);
    day.ftds = Number(row.ftds ?? 0);
  }
  for (const row of activityRows) {
    const day = dayFor(row.metric_date);
    // Spec §3 / global-constraints.md: recuperação = crm_influenced_revenue,
    // never crm_direct_revenue.
    day.recovered = Number(row.crm_influenced_revenue ?? 0);
  }
  return [...byDate.values()];
}

/**
 * Full "Saúde" panel for the super admin: per-house health rows and sorted
 * platform alerts. `opts.now` drives every time-sensitive comparison
 * (job/queue/provider/billing alerts); the 60 s result cache always uses the
 * real wall clock so tests calling twice in the same tick observe it.
 * `opts.fresh` bypasses the cache.
 */
export async function adminPlatformHealthFor(
  ctx: { userId: string },
  opts: { now?: Date; fresh?: boolean } = {},
): Promise<PlatformHealth> {
  await assertSuperAdmin(ctx.userId);

  const nowMs = Date.now();
  if (cache && !opts.fresh && nowMs - cache.at < CACHE_MS) {
    return cache.value;
  }

  const now = opts.now ?? new Date();
  const windows = healthWindows(todaySaoPaulo());
  const alerts: PlatformAlert[] = [];

  async function fromSource<T>(
    name: string,
    promise: Promise<T>,
    fallback: T,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      });
      return await Promise.race([promise, timeout]);
    } catch (error) {
      console.error(`[platform-health] source failed: ${name}`, { error: errorText(error) });
      alerts.push(sourceFailureAlert(name));
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const houseTenants = await fromSource<HouseTenantRow[]>("tenants", fetchHouseTenants(), []);
  const tenantIds = houseTenants.map((house) => house.id);
  const range = { from: windows.base.from, to: windows.current.to };

  const [
    financeRows,
    activityRows,
    jobRows,
    queueRows,
    breakerRows,
    rateRows,
    shortioRuns,
    runwayRows,
    billingReport,
    webhookStats,
  ] = await Promise.all([
    fromSource<FinanceDayRow[]>("finance_days", fetchFinanceDays(tenantIds, range), []),
    fromSource<ActivityDayRow[]>("finance_activity_days", fetchActivityDays(tenantIds, range), []),
    fromSource<JobHealthRow[]>(
      "observability_job_health",
      fetchObservabilityRpc<JobHealthRow>("observability_job_health"),
      [],
    ),
    fromSource<QueueMetricRow[]>(
      "observability_queue_metrics",
      fetchObservabilityRpc<QueueMetricRow>("observability_queue_metrics"),
      [],
    ),
    fromSource<BreakerRow[]>("provider_circuit_breakers", fetchBreakers(), []),
    fromSource<RateStateRow[]>("dispatch_rate_state", fetchRateStates(), []),
    fromSource<ShortioRunRow[]>("shortio_sync_runs", fetchShortioRuns(), []),
    fromSource<RunwayRow[]>("billing_runway_alert_candidates", fetchRunwayCandidates(), []),
    fromSource("billing_health", checkBillingHealth({ windowHours: 24, now }), {
      ok: true,
      checkedAt: now.toISOString(),
      windowHours: 24,
      findings: [],
    }),
    fromSource<WebhookStats[]>("webhook_logs", fetchWebhookStats(houseTenants, now), []),
  ]);

  const financeByTenant = groupByTenant(financeRows);
  const activityByTenant = groupByTenant(activityRows);

  const houseRows: HouseHealthRow[] = [];
  const quietHouses: Array<{ tenantId: string; name: string }> = [];
  for (const house of houseTenants) {
    const input: HouseHealthInput = {
      tenantId: house.id,
      name: house.nome,
      moeda: house.moeda ?? DEFAULT_CURRENCY,
      days: buildHouseDays(
        financeByTenant.get(house.id) ?? [],
        activityByTenant.get(house.id) ?? [],
      ),
    };
    const row = summarizeHouse(input, windows);
    if (row === null) quietHouses.push({ tenantId: house.id, name: house.nome });
    else houseRows.push(row);
  }

  const houseNames = new Map(houseTenants.map((house) => [house.id, house.nome]));

  const result: PlatformHealth = {
    checkedAt: now.toISOString(),
    window: windows.current,
    alerts: sortAlerts([
      ...alerts,
      ...jobAlerts(jobRows, now),
      ...webhookAlerts(webhookStats, now),
      ...queueAlerts(queueRows, houseNames),
      ...providerAlerts({ breakers: breakerRows, rateStates: rateRows, shortioRuns }, now),
      ...runwayAlerts(runwayRows),
      ...billingAlerts(billingReport),
    ]),
    houses: sortHouses(houseRows),
    quietHouses,
  };

  cache = { at: Date.now(), value: result };
  return result;
}
