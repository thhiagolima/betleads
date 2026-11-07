import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  // Same partial-unique-index model as alert-store.server.test.ts.
  fake.admin = createFakeDb({ unique: { platform_alerts: [["alert_key", "resolved_at"]] } });
  return { supabaseAdmin: fake.admin.client };
});

const mocks = vi.hoisted(() => ({
  adminPlatformHealthFor: vi.fn(),
  invalidatePlatformHealthCache: vi.fn(),
}));
vi.mock("./platform-health.server", () => ({
  adminPlatformHealthFor: mocks.adminPlatformHealthFor,
  invalidatePlatformHealthCache: mocks.invalidatePlatformHealthCache,
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import type { PlatformAlert } from "./alert-rules";
import { loadOpenAlerts } from "./alert-store.server";
import {
  adminAcknowledgeAlertFor,
  adminAlertHistoryFor,
  adminSilenceAlertFor,
} from "./platform-alerts.functions";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000bb";

function ctxFor(userId: string) {
  return { userId };
}

function alert(key: string, overrides: Partial<PlatformAlert> = {}): PlatformAlert {
  return {
    key,
    kind: "job",
    severity: "critical",
    message: `Mensagem de ${key}`,
    tenantId: null,
    since: null,
    href: "/admin#canais",
    ...overrides,
  };
}

function healthWith(alerts: PlatformAlert[]) {
  return {
    checkedAt: new Date().toISOString(),
    window: { from: "2026-11-01", to: "2026-11-05" },
    alerts,
    houses: [],
    quietHouses: [],
    housesUnavailable: false,
    recoveryUnavailable: false,
  };
}

const openRows = () => fake.admin.rows("platform_alerts").filter((row) => row.resolved_at == null);

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  mocks.adminPlatformHealthFor.mockReset();
  mocks.invalidatePlatformHealthCache.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adminAcknowledgeAlertFor", () => {
  it("rejects a non-super-admin", async () => {
    await expect(adminAcknowledgeAlertFor(ctxFor(PLAIN_USER), { key: "job:a" })).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
    expect(openRows()).toHaveLength(0);
  });

  it("acknowledges a computed-but-unstored alert: creates the open row, already acknowledged", async () => {
    mocks.adminPlatformHealthFor.mockResolvedValue(healthWith([alert("job:a")]));

    await adminAcknowledgeAlertFor(ctxFor(SUPER_ADMIN), { key: "job:a" });

    const [row] = await loadOpenAlerts();
    expect(row).toMatchObject({ alertKey: "job:a", acknowledgedAt: expect.any(String) });
    // Fix round 1: the write must invalidate the 60 s module cache, or the tab's refetch would
    // keep serving a stale (not-yet-acknowledged) alert for up to a minute.
    expect(mocks.invalidatePlatformHealthCache).toHaveBeenCalledTimes(1);
  });

  it("throws when the key is neither stored nor in the current computed alerts", async () => {
    mocks.adminPlatformHealthFor.mockResolvedValue(healthWith([]));

    await expect(adminAcknowledgeAlertFor(ctxFor(SUPER_ADMIN), { key: "job:x" })).rejects.toThrow(
      "Alerta não encontrado.",
    );
  });
});

describe("adminSilenceAlertFor", () => {
  it("rejects a non-super-admin", async () => {
    await expect(adminSilenceAlertFor(ctxFor(PLAIN_USER), { key: "job:a" })).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
  });

  it("silences a computed-but-unstored alert: creates the open row with silenced_until set", async () => {
    mocks.adminPlatformHealthFor.mockResolvedValue(healthWith([alert("job:a")]));

    await adminSilenceAlertFor(ctxFor(SUPER_ADMIN), { key: "job:a" });

    const [row] = await loadOpenAlerts();
    expect(row.alertKey).toBe("job:a");
    expect(row.silencedUntil).not.toBeNull();
    expect(mocks.invalidatePlatformHealthCache).toHaveBeenCalledTimes(1);
  });
});

describe("adminAlertHistoryFor", () => {
  it("rejects a non-super-admin", async () => {
    await expect(adminAlertHistoryFor(ctxFor(PLAIN_USER))).rejects.toThrow(
      "Apenas o super admin pode realizar esta ação.",
    );
  });

  it("returns resolved rows, newest first", async () => {
    fake.admin.rows("platform_alerts").push(
      {
        id: "r1",
        alert_key: "job:1",
        kind: "job",
        severity: "critical",
        message: "m1",
        seen_count: 1,
        resolved_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
      {
        id: "r2",
        alert_key: "job:2",
        kind: "job",
        severity: "critical",
        message: "m2",
        seen_count: 1,
        resolved_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    );

    const history = await adminAlertHistoryFor(ctxFor(SUPER_ADMIN));

    expect(history.map((row) => row.alertKey)).toEqual(["job:2", "job:1"]);
  });
});
