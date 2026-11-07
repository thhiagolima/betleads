import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { checkBillingHealth } = vi.hoisted(() => ({ checkBillingHealth: vi.fn() }));
vi.mock("@/lib/billing/billing-health.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/billing-health.server")>();
  return { ...actual, checkBillingHealth };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { todaySaoPaulo } from "@/lib/finance/finance-data.server";

import { acknowledgeAlert } from "./alert-store.server";
import { healthWindows } from "./house-health";
import { sortAlerts } from "./alert-rules";
import {
  __resetPlatformHealthCacheForTests,
  adminPlatformHealthFor,
  estimateEventsPerDay,
  invalidatePlatformHealthCache,
} from "./platform-health.server";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000bb";
const HOUSE_A = "00000000-0000-4000-8000-0000000000a1";
const HOUSE_B = "00000000-0000-4000-8000-0000000000b1";
const HOUSE_DEMO = "00000000-0000-4000-8000-0000000000d1";

function ctxFor(userId: string) {
  return { userId };
}

function addDays(s: string, delta: number): string {
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

const windows = healthWindows(todaySaoPaulo());
const allDates = datesInRange(windows.base.from, windows.current.to);

/** Registers finance_days/finance_activity_days with movement only for HOUSE_A. */
function registerFinanceAndActivity() {
  fake.admin.onRpc("finance_days", () => ({
    data: allDates.map((date) => ({
      tenant_id: HOUSE_A,
      metric_date: date,
      registrations: 5,
      ftds: 1,
    })),
    error: null,
  }));
  fake.admin.onRpc("finance_activity_days", () => ({
    data: allDates.map((date) => ({
      tenant_id: HOUSE_A,
      metric_date: date,
      crm_influenced_revenue: 100,
    })),
    error: null,
  }));
}

function registerNoOpObservability() {
  fake.admin.onRpc("observability_job_health", () => ({ data: [], error: null }));
  fake.admin.onRpc("observability_queue_metrics", () => ({ data: [], error: null }));
  fake.admin.onRpc("billing_runway_alert_candidates", () => ({ data: [], error: null }));
}

function pushHouses() {
  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", moeda: "BRL", status: "active", is_demo: false },
      { id: HOUSE_B, nome: "Casa B", moeda: "BRL", status: "active", is_demo: false },
      { id: HOUSE_DEMO, nome: "Casa Demo", moeda: "BRL", status: "active", is_demo: true },
    );
}

beforeEach(() => {
  fake.admin.reset();
  __resetPlatformHealthCacheForTests();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  checkBillingHealth.mockReset().mockResolvedValue({
    ok: true,
    checkedAt: new Date().toISOString(),
    windowHours: 24,
    findings: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `count` webhook_logs rows for a house, every `stepMs`, the newest at `newestMs`. */
function pushWebhookEvents(tenantId: string, count: number, newestMs: number, stepMs: number) {
  for (let i = 0; i < count; i++) {
    fake.admin.rows("webhook_logs").push({
      id: `${tenantId}-wh-${i}`,
      tenant_id: tenantId,
      status: "ok",
      created_at: new Date(newestMs - i * stepMs).toISOString(),
    });
  }
}

const DAY_MS = 86_400_000;

describe("adminPlatformHealthFor", () => {
  it("rejects a non-super-admin without reading any other table", async () => {
    const rpcSpy = vi.spyOn(fake.admin.client, "rpc");
    await expect(adminPlatformHealthFor(ctxFor(PLAIN_USER))).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
    expect(fake.admin.calls).toHaveLength(0);
    expect(rpcSpy.mock.calls.map((call) => call[0])).toEqual(["is_super_admin"]);
  });

  it("skips per-house alerts for a demo or unknown house (queue, runway)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    const stuck = {
      channel: "sms",
      ready: 5,
      paused: 0,
      oldest_ready_age_seconds: 4000,
      sent_15m: 0,
      errors_15m: 0,
    };
    fake.admin.onRpc("observability_queue_metrics", () => ({
      data: [
        { tenant_id: HOUSE_DEMO, ...stuck },
        { tenant_id: "00000000-0000-4000-8000-0000000000ff", ...stuck },
      ],
      error: null,
    }));
    fake.admin.onRpc("billing_runway_alert_candidates", () => ({
      data: [{ tenant_id: HOUSE_DEMO, tenant_name: "Casa Demo", runway_hours: 1 }],
      error: null,
    }));

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.alerts.filter((a) => a.kind === "queue" || a.kind === "runway")).toEqual([]);
  });

  it("alerts 'saldo zerado' for a non-exempt house with balance <= 0 (not exempt, not demo)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    fake.admin.onRpc("billing_tenant_exempt", (args) => ({
      data: args._tenant === HOUSE_B,
      error: null,
    }));
    fake.admin
      .rows("tenant_wallets")
      .push(
        { tenant_id: HOUSE_A, balance: 0 },
        { tenant_id: HOUSE_B, balance: 0 },
        { tenant_id: HOUSE_DEMO, balance: 0 },
      );

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    const zero = result.alerts.filter((a) => a.key.endsWith(":zero"));
    expect(zero).toEqual([
      expect.objectContaining({
        key: `runway:${HOUSE_A}:zero`,
        severity: "critical",
        message: "Casa A: saldo zerado — envios parados",
        href: "/admin#saldo",
      }),
    ]);
  });

  it("finance_days failure: no house table (housesUnavailable), not a false 'sem movimento'", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    fake.admin.onRpc("finance_days", () => ({ data: null, error: { message: "boom" } }));

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.housesUnavailable).toBe(true);
    expect(result.houses).toEqual([]);
    expect(result.quietHouses).toEqual([]);
    expect(result.alerts).toContainEqual(
      expect.objectContaining({ key: "source:finance_days", href: null }),
    );
  });

  it("finance_activity_days failure: houses stay, recovery is unknown (recoveryUnavailable)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    fake.admin.onRpc("finance_activity_days", () => ({ data: null, error: { message: "boom" } }));

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.housesUnavailable).toBe(false);
    expect(result.recoveryUnavailable).toBe(true);
    expect(result.houses.map((h) => h.tenantId)).toEqual([HOUSE_A]);
    expect(result.houses[0].deltas.recoveredPct).toBeNull();
  });

  it("a busy house silent for 2 days is still alerted (rate measured up to the last event)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    // ~1000/day (every 86.4 s) until 2 days ago.
    pushWebhookEvents(HOUSE_A, 300, Date.now() - 2 * DAY_MS, 86_400);

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.alerts).toContainEqual(
      expect.objectContaining({ key: `webhook:${HOUSE_A}:silence`, severity: "critical" }),
    );
  });

  it("a small house silent for 2 days is still alerted (n < 200 rate over the active span)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    // 150 events every hour until 2 days ago -> ~24/day over the 5 active days.
    pushWebhookEvents(HOUSE_A, 150, Date.now() - 2 * DAY_MS, 3_600_000);

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.alerts).toContainEqual(
      expect.objectContaining({ key: `webhook:${HOUSE_A}:silence`, severity: "warning" }),
    );
  });

  it("a house with movement and no webhook for 8 days is critical (latest read without the 7-day bound)", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    pushWebhookEvents(HOUSE_A, 50, Date.now() - 8 * DAY_MS, 60_000);

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        key: `webhook:${HOUSE_A}:silence`,
        severity: "critical",
        message: "Casa A sem webhook há mais de 7 dias",
      }),
    );
  });

  it("one house's webhook read failing only drops that house (source:webhook_logs:<casa>)", async () => {
    pushHouses();
    registerNoOpObservability();
    fake.admin.onRpc("finance_days", () => ({
      data: allDates.flatMap((date) =>
        [HOUSE_A, HOUSE_B].map((tenant_id) => ({
          tenant_id,
          metric_date: date,
          registrations: 5,
          ftds: 1,
        })),
      ),
      error: null,
    }));
    fake.admin.onRpc("finance_activity_days", () => ({ data: [], error: null }));
    pushWebhookEvents(HOUSE_B, 10, Date.now() - 8 * DAY_MS, 60_000);
    // The first webhook_logs read is Casa A's (houses are read in order).
    fake.admin.failNext("webhook_logs", "select");

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    const keys = result.alerts.map((a) => a.key);
    expect(keys).toContain("source:webhook_logs:Casa A");
    expect(keys).not.toContain("source:webhook_logs");
    expect(keys).toContain(`webhook:${HOUSE_B}:silence`);
  });

  it("opts.now drives the São Paulo windows", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();

    // 02:00 UTC on 11-10 is still 11-09 in São Paulo.
    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN), {
      now: new Date("2026-11-10T02:00:00.000Z"),
    });

    expect(result.window).toEqual(healthWindows("2026-11-09").current);
    expect(result.checkedAt).toBe("2026-11-10T02:00:00.000Z");
  });

  it("concurrent cold calls share one fan-out", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();

    const [first, second] = await Promise.all([
      adminPlatformHealthFor(ctxFor(SUPER_ADMIN)),
      adminPlatformHealthFor(ctxFor(SUPER_ADMIN)),
    ]);

    expect(second).toBe(first);
    expect(fake.admin.calls.filter((c) => c.table === "tenants")).toHaveLength(1);
  });

  it("a hanging source times out after 8 s into a source warning; the rest still loads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pushHouses();
      registerFinanceAndActivity();
      registerNoOpObservability();
      fake.admin.onRpc("observability_job_health", () => new Promise(() => {}));

      const pending = adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;

      expect(result.alerts).toContainEqual(
        expect.objectContaining({ key: "source:observability_job_health", href: "/admin#canais" }),
      );
      expect(result.houses.map((h) => h.tenantId)).toEqual([HOUSE_A]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds houses/quietHouses, excluding the demo house; an all-zero house goes to quietHouses", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.houses.map((h) => h.tenantId)).toEqual([HOUSE_A]);
    expect(result.quietHouses).toEqual([{ tenantId: HOUSE_B, name: "Casa B" }]);
    expect(result.houses.some((h) => h.tenantId === HOUSE_DEMO)).toBe(false);
    expect(result.quietHouses.some((h) => h.tenantId === HOUSE_DEMO)).toBe(false);
  });

  it("still returns houses, with a source:observability_job_health warning, when that RPC errors", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    fake.admin.onRpc("observability_job_health", () => ({
      data: null,
      error: { message: "boom" },
    }));

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.houses.map((h) => h.tenantId)).toEqual([HOUSE_A]);
    expect(result.alerts).toContainEqual(
      expect.objectContaining({ key: "source:observability_job_health", severity: "warning" }),
    );
  });

  it("caches the result for 60s (no new reads on the second call); fresh bypasses the cache", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();

    const rpcSpy = vi.spyOn(fake.admin.client, "rpc");
    const first = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
    const callsAfterFirst = fake.admin.calls.length;
    const rpcCallsAfterFirst = rpcSpy.mock.calls.length;

    const second = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
    expect(second).toBe(first);
    expect(fake.admin.calls.length).toBe(callsAfterFirst);
    // Only the is_super_admin check runs again; no new data RPCs.
    expect(rpcSpy.mock.calls.length).toBe(rpcCallsAfterFirst + 1);

    const fresh = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN), { fresh: true });
    expect(fresh).not.toBe(first);
    expect(fake.admin.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("returns alerts already sorted (sortAlerts): critical before warning", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    // A critical provider alert (no balance) and a warning queue alert, fetched
    // independently and in no particular order — the loader must sort them.
    fake.admin.rows("provider_circuit_breakers").push({
      channel: "sms",
      state: "open",
      reason: "no_balance",
      first_opened_at: "2026-11-01T00:00:00.000Z",
    });
    fake.admin.rows("dispatch_rate_state").push({
      channel: "email",
      last_provider_error: "500",
      backoff_until: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));

    expect(result.alerts).toEqual(sortAlerts(result.alerts));
    const criticalIdx = result.alerts.findIndex((a) => a.severity === "critical");
    const warningIdx = result.alerts.findIndex((a) => a.severity === "warning");
    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeGreaterThan(criticalIdx);
  });

  it("fix round 1: invalidatePlatformHealthCache() makes the next call see a just-acknowledged alert", async () => {
    pushHouses();
    registerFinanceAndActivity();
    registerNoOpObservability();
    fake.admin.onRpc("observability_job_health", () => ({
      data: [
        {
          job: "sms_tick",
          last_started_at: "2026-01-01T00:00:00.000Z",
          last_status: "running",
          seconds_since_last_start: null,
          stale_running: 1,
          oldest_running_heartbeat_at: "2026-01-01T00:00:00.000Z",
          runs_last_hour: 0,
          failed_last_hour: 0,
          partial_last_hour: 0,
        },
      ],
      error: null,
    }));

    const first = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
    const jobAlert = first.alerts.find((a) => a.kind === "job");
    expect(jobAlert).toBeDefined();
    expect(jobAlert!.stored).toBeNull();

    await acknowledgeAlert(jobAlert!.key, SUPER_ADMIN, jobAlert!, new Date());

    // Still cached: the write is invisible without invalidating.
    const stillStale = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
    expect(stillStale.alerts.find((a) => a.key === jobAlert!.key)?.stored).toBeNull();

    invalidatePlatformHealthCache();

    const fresh = await adminPlatformHealthFor(ctxFor(SUPER_ADMIN));
    const freshAlert = fresh.alerts.find((a) => a.key === jobAlert!.key);
    expect(freshAlert?.stored?.acknowledgedAt).not.toBeNull();
  });
});

describe("estimateEventsPerDay", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");

  it("returns 0 for no events", () => {
    expect(estimateEventsPerDay([], now)).toBe(0);
  });

  it("measures the rate up to the last event when fewer than 200 (silent 2 days -> n / 5)", () => {
    const newest = now.getTime() - 2 * 86_400_000;
    const createdAtDesc = Array.from({ length: 35 }, (_, i) =>
      new Date(newest - i * 3_600_000).toISOString(),
    );
    expect(estimateEventsPerDay(createdAtDesc, now)).toBeCloseTo(35 / 5);
  });

  it("floors the active span at 1 h (n < 200)", () => {
    const createdAtDesc = [new Date(now.getTime() - 7 * 86_400_000 + 60_000).toISOString()];
    expect(estimateEventsPerDay(createdAtDesc, now)).toBeCloseTo(24);
  });

  it("estimates n/7 when fewer than 200 events were sampled", () => {
    const createdAtDesc = Array.from({ length: 35 }, (_, i) =>
      new Date(now.getTime() - i * 3_600_000).toISOString(),
    );
    expect(estimateEventsPerDay(createdAtDesc, now)).toBeCloseTo(35 / 7);
  });

  it("estimates 200 / span-in-days when the 200-row sample is full (2 days -> 100/day)", () => {
    const newest = now.toISOString();
    const oldest = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const createdAtDesc = [newest, ...Array.from({ length: 198 }, () => now.toISOString()), oldest];
    expect(estimateEventsPerDay(createdAtDesc, now)).toBeCloseTo(100);
  });
});
