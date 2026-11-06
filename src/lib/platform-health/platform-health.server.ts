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
// value, so one bad source never breaks the whole panel. A fallback that
// would read as real data is flagged instead: `housesUnavailable` (no house
// table when `finance_days`/`tenants` failed) and `recoveryUnavailable`
// (recovery unknown when `finance_activity_days` failed).
//
// Every per-house source is limited to the loader's house set (non-demo,
// non-canceled) before the rules run.

import { DEFAULT_CURRENCY } from "@/lib/currency";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertSuperAdmin, checkBillingHealth } from "@/lib/billing/billing-health.server";
import { presetRange } from "@/lib/finance/calc";
import type { ActivityDayRow, FinanceDayRow } from "@/lib/finance/finance-data.server";
import { fetchActivityDays, fetchFinanceDays } from "@/lib/finance/finance-data.server";

import type { StoredAlert } from "./alert-lifecycle";
import {
  billingAlerts,
  jobAlerts,
  providerAlerts,
  queueAlerts,
  runwayAlerts,
  sortAlerts,
  sourceFailureAlert,
  webhookAlerts,
  zeroBalanceAlerts,
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

/** The stored row's lifecycle fields (Task 5/F3), joined onto each computed alert by key. */
export type StoredAlertInfo = {
  openedAt: string;
  acknowledgedAt: string | null;
  silencedUntil: string | null;
};

export type PlatformHealth = {
  checkedAt: string;
  window: HealthWindows["current"];
  alerts: Array<PlatformAlert & { stored: StoredAlertInfo | null }>;
  houses: HouseHealthRow[];
  quietHouses: Array<{ tenantId: string; name: string }>;
  /** `finance_days` (or `tenants`) failed: `houses`/`quietHouses` are empty, not "sem movimento". */
  housesUnavailable: boolean;
  /** `finance_activity_days` failed: recovery is unknown (deltas null, cells "—"). */
  recoveryUnavailable: boolean;
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
/** Cold load in progress: concurrent non-fresh callers share it (one fan-out). */
let inflight: Promise<PlatformHealth> | null = null;

/** Test hook: forget the cached result so the next call fetches fresh. */
export function __resetPlatformHealthCacheForTests(): void {
  cache = null;
  inflight = null;
}

/**
 * Forgets the cached result so the next `adminPlatformHealthFor` call fetches
 * fresh. Called after a write that the cache can't see on its own (Task 5
 * fix round 1: acknowledging/silencing an alert), so the tab's next refetch
 * — and the acting admin's own `invalidateQueries` — doesn't serve a stale
 * `acknowledgedAt`/`silencedUntil` for up to `CACHE_MS`.
 */
export function invalidatePlatformHealthCache(): void {
  cache = null;
  inflight = null;
}

const DEFAULT_TIMEOUT_MS = 8000;

const WEBHOOK_SAMPLE_DAYS = 7;
const WEBHOOK_SAMPLE_LIMIT = 200;
const WEBHOOK_STATS_CONCURRENCY = 4;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * The last ≤200 `webhook_logs.created_at` of the past 7 days (newest first)
 * estimate a house's daily event rate. Under the 200-row sample: `n` over the
 * days from the start of the 7-day window up to the last event (floored at
 * 1 h), so a house that went silent keeps its pre-silence rate instead of
 * diluting it with the silence. A full sample: `200 / (newest − oldest in
 * days)` (a 7-day exact count is too slow for the biggest houses).
 */
export function estimateEventsPerDay(createdAtDesc: string[], now: Date): number {
  const n = createdAtDesc.length;
  if (n === 0) return 0;
  const newest = new Date(createdAtDesc[0]).getTime();
  if (n < WEBHOOK_SAMPLE_LIMIT) {
    const windowStart = now.getTime() - WEBHOOK_SAMPLE_DAYS * 86_400_000;
    const activeDays = Math.max((newest - windowStart) / 86_400_000, 1 / 24);
    return n / activeDays;
  }
  const oldest = new Date(createdAtDesc[n - 1]).getTime();
  // Guard against a zero (or negative, out-of-order) span: floor it to one
  // minute so the estimate stays a large-but-finite number instead of Infinity.
  const spanDays = Math.max((newest - oldest) / 86_400_000, 1 / 1440);
  return WEBHOOK_SAMPLE_LIMIT / spanDays;
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

/**
 * Every open stored alert (Task 3's `alert-store.server.ts`), dynamically
 * imported so this module and `alert-store.server.ts` (which imports
 * `computePlatformHealth` from here for its cron) don't form a static
 * circular import — same precedent as `billing-admin.functions.ts`'s
 * dynamic imports of its sibling `*.server.ts` files.
 */
async function fetchStoredAlerts(): Promise<StoredAlert[]> {
  const { loadOpenAlerts } = await import("./alert-store.server");
  return loadOpenAlerts();
}

/**
 * Houses (of the given set) whose wallet balance is ≤ 0 and that are not
 * exempt (`billing_tenant_exempt`, the same check the no-balance e-mail
 * uses; called only for the few zero-balance houses).
 */
async function fetchZeroBalanceHouses(
  houses: HouseTenantRow[],
): Promise<Array<{ tenantId: string; name: string }>> {
  if (houses.length === 0) return [];
  const names = new Map(houses.map((house) => [house.id, house.nome]));
  const { data, error } = await db()
    .from("tenant_wallets")
    .select("tenant_id,balance")
    .in("tenant_id", [...names.keys()])
    .lte("balance", 0);
  if (error) throw new Error(errorText(error));
  const zeroIds = ((data ?? []) as Array<{ tenant_id: string; balance: number | string }>)
    .filter((row) => names.has(row.tenant_id) && Number(row.balance) <= 0)
    .map((row) => row.tenant_id);
  const exempt = await Promise.all(
    zeroIds.map(async (tenantId) => {
      const res = await db().rpc("billing_tenant_exempt", { _tenant: tenantId });
      if (res.error) throw new Error(errorText(res.error));
      return res.data === true;
    }),
  );
  return zeroIds
    .filter((_, i) => !exempt[i])
    .map((tenantId) => ({ tenantId, name: names.get(tenantId) as string }));
}

type HouseWebhookStats = Omit<WebhookStats, "hasMovement">;

/**
 * Per house: the last ≤200 `webhook_logs` of the past 7 days (index-only
 * scan), the latest event with no date bound (limit 1, index-only — so a
 * house silent for more than 7 days still has a `lastEventAt`) and the 24 h
 * `status = 'erro'` count (exact head count, served by
 * `webhook_logs_tenant_status_created_idx`) — see `estimateEventsPerDay`.
 * A house whose reads fail is reported through `onHouseFailure` and left
 * out; the other houses keep their stats.
 */
async function fetchWebhookStats(
  houses: HouseTenantRow[],
  now: Date,
  onHouseFailure: (house: HouseTenantRow, error: unknown) => void,
): Promise<HouseWebhookStats[]> {
  const sevenDaysAgo = new Date(now.getTime() - WEBHOOK_SAMPLE_DAYS * 86_400_000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const stats: HouseWebhookStats[] = [];
  await runLimited(houses, WEBHOOK_STATS_CONCURRENCY, async (house) => {
    try {
      const [events, latest, errors] = await Promise.all([
        db()
          .from("webhook_logs")
          .select("created_at")
          .eq("tenant_id", house.id)
          .gte("created_at", sevenDaysAgo)
          .order("created_at", { ascending: false })
          .limit(WEBHOOK_SAMPLE_LIMIT),
        db()
          .from("webhook_logs")
          .select("created_at")
          .eq("tenant_id", house.id)
          .order("created_at", { ascending: false })
          .limit(1),
        db()
          .from("webhook_logs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", house.id)
          .eq("status", "erro")
          .gte("created_at", since24h),
      ]);
      if (events.error) throw new Error(errorText(events.error));
      if (latest.error) throw new Error(errorText(latest.error));
      if (errors.error) throw new Error(errorText(errors.error));
      const createdAtDesc = ((events.data ?? []) as Array<{ created_at: string }>).map(
        (r) => r.created_at,
      );
      const latestRow = ((latest.data ?? []) as Array<{ created_at: string }>)[0];
      stats.push({
        tenantId: house.id,
        name: house.nome,
        lastEventAt: latestRow?.created_at ?? createdAtDesc[0] ?? null,
        eventsPerDay: estimateEventsPerDay(createdAtDesc, now),
        errors24h: errors.count ?? 0,
      });
    } catch (error) {
      onHouseFailure(house, error);
    }
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
 * platform alerts. `opts.now` drives every time-sensitive comparison (the
 * São Paulo day of the windows, job/queue/provider/webhook/billing alerts);
 * the 60 s result cache always uses the real wall clock so tests calling
 * twice in the same tick observe it. `opts.fresh` bypasses the cache.
 * Concurrent cold (non-fresh) calls share one in-flight load.
 */
export async function adminPlatformHealthFor(
  ctx: { userId: string },
  opts: { now?: Date; fresh?: boolean } = {},
): Promise<PlatformHealth> {
  await assertSuperAdmin(ctx.userId);

  if (!opts.fresh) {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    if (inflight) return inflight;
  }

  const load = computePlatformHealth(opts.now ?? new Date());
  if (opts.fresh) return load;
  inflight = load;
  try {
    return await load;
  } finally {
    if (inflight === load) inflight = null;
  }
}

/**
 * One full health computation at `now`: no auth check and no cache. Used by
 * `adminPlatformHealthFor` (behind `assertSuperAdmin` + the 60 s cache) and
 * by the platform-alerts cron (`alert-store.server.ts`), which is already
 * behind `requireSharedSecret`.
 */
export async function computePlatformHealth(now: Date): Promise<PlatformHealth> {
  const windows = healthWindows(presetRange("today", now).from);
  const alerts: PlatformAlert[] = [];
  const failed = new Set<string>();

  function reportFailure(name: string, error: unknown) {
    console.error(`[platform-health] source failed: ${name}`, { error: errorText(error) });
    failed.add(name);
    alerts.push(sourceFailureAlert(name));
  }

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
      reportFailure(name, error);
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const houseTenants = await fromSource<HouseTenantRow[]>("tenants", fetchHouseTenants(), []);
  const tenantIds = houseTenants.map((house) => house.id);
  const houseIds = new Set(tenantIds);
  const houseNames = new Map(houseTenants.map((house) => [house.id, house.nome]));
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
    zeroBalanceHouses,
    storedAlerts,
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
    fromSource<HouseWebhookStats[]>(
      "webhook_logs",
      fetchWebhookStats(houseTenants, now, (house, error) =>
        reportFailure(`webhook_logs:${house.nome}`, error),
      ),
      [],
    ),
    fromSource("tenant_wallets", fetchZeroBalanceHouses(houseTenants), []),
    fromSource<StoredAlert[]>("platform_alerts", fetchStoredAlerts(), []),
  ]);

  const housesUnavailable = failed.has("tenants") || failed.has("finance_days");
  const recoveryUnavailable = failed.has("finance_activity_days");

  const houseRows: HouseHealthRow[] = [];
  const quietHouses: Array<{ tenantId: string; name: string }> = [];
  if (!housesUnavailable) {
    const financeByTenant = groupByTenant(financeRows);
    const activityByTenant = groupByTenant(activityRows);
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
      const row = summarizeHouse(input, windows, { recoveryUnavailable });
      if (row === null) quietHouses.push({ tenantId: house.id, name: house.nome });
      else houseRows.push(row);
    }
  }

  // "Movement in the table" = cadastros in the current or base window.
  const housesWithMovement = new Set(
    houseRows
      .filter((row) => row.current.registrations > 0 || row.base.registrations > 0)
      .map((row) => row.tenantId),
  );

  // Task 5/F3: join each alert with its stored lifecycle row (by key), so the UI can show
  // acknowledged/silenced state and act on it. Applied before `sortAlerts` so a rule-less
  // `since` (filled from `stored.openedAt`) still sorts correctly.
  const storedByKey = new Map(storedAlerts.map((row) => [row.alertKey, row]));
  function withStored(alert: PlatformAlert): PlatformAlert & { stored: StoredAlertInfo | null } {
    const row = storedByKey.get(alert.key);
    const stored: StoredAlertInfo | null = row
      ? {
          openedAt: row.openedAt,
          acknowledgedAt: row.acknowledgedAt,
          silencedUntil: row.silencedUntil,
        }
      : null;
    return { ...alert, since: alert.since ?? stored?.openedAt ?? null, stored };
  }

  const result: PlatformHealth = {
    checkedAt: now.toISOString(),
    window: windows.current,
    alerts: sortAlerts(
      [
        ...alerts,
        ...jobAlerts(jobRows, now),
        ...webhookAlerts(
          webhookStats
            .filter((stat) => houseIds.has(stat.tenantId))
            .map((stat) => ({ ...stat, hasMovement: housesWithMovement.has(stat.tenantId) })),
          now,
        ),
        ...queueAlerts(
          queueRows.filter((row) => houseIds.has(row.tenant_id)),
          houseNames,
          now,
        ),
        ...providerAlerts({ breakers: breakerRows, rateStates: rateRows, shortioRuns }, now),
        ...runwayAlerts(runwayRows.filter((row) => houseIds.has(row.tenant_id))),
        ...zeroBalanceAlerts(zeroBalanceHouses),
        ...billingAlerts(billingReport),
      ].map(withStored),
    ),
    houses: sortHouses(houseRows),
    quietHouses,
    housesUnavailable,
    recoveryUnavailable,
  };

  cache = { at: Date.now(), value: result };
  return result;
}
