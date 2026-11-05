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

import { healthWindows } from "./house-health";
import { sortAlerts } from "./alert-rules";
import {
  __resetPlatformHealthCacheForTests,
  adminPlatformHealthFor,
  estimateEventsPerDay,
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

describe("adminPlatformHealthFor", () => {
  it("rejects a non-super-admin without reading any other table", async () => {
    await expect(adminPlatformHealthFor(ctxFor(PLAIN_USER))).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
    expect(fake.admin.calls).toHaveLength(0);
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
});

describe("estimateEventsPerDay", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");

  it("returns 0 for no events", () => {
    expect(estimateEventsPerDay([], now)).toBe(0);
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
