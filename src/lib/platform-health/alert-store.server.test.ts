import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  // Models the partial unique index `platform_alerts_one_open_per_key`
  // (alert_key where resolved_at is null): inserts always carry
  // resolved_at: null, so they collide only with an open row of the key.
  fake.admin = createFakeDb({ unique: { platform_alerts: [["alert_key", "resolved_at"]] } });
  (fake.admin.client as unknown as { auth: unknown }).auth = {
    admin: { getUserById: vi.fn() },
  };
  return { supabaseAdmin: fake.admin.client };
});

const mocks = vi.hoisted(() => ({
  computePlatformHealth: vi.fn(),
  sendPlatformEmail: vi.fn(),
}));
vi.mock("./platform-health.server", () => ({
  computePlatformHealth: mocks.computePlatformHealth,
}));
vi.mock("@/lib/billing/billing-emails.server", () => ({
  sendPlatformEmail: mocks.sendPlatformEmail,
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import type { PlatformAlert } from "./alert-rules";
import { CRITICAL_RENOTIFY_MS, HISTORY_DAYS, SILENCE_HOURS } from "./alert-lifecycle";
import {
  acknowledgeAlert,
  listAlertHistory,
  loadOpenAlerts,
  silenceAlert,
  syncPlatformAlerts,
} from "./alert-store.server";

const SUPER_1 = "00000000-0000-4000-8000-000000000001";
const SUPER_2 = "00000000-0000-4000-8000-000000000002";
const HOUSE_ADMIN = "00000000-0000-4000-8000-000000000003";
const HOUSE_A = "00000000-0000-4000-8000-0000000000a1";

const EMAIL_BY_USER: Record<string, string> = {
  [SUPER_1]: "root1@betleads.io",
  [SUPER_2]: "root2@betleads.io",
  [HOUSE_ADMIN]: "admin@casa-a.com",
};

const NOW = new Date("2026-11-05T15:00:00.000Z");
const LATER = new Date(NOW.getTime() + 5 * 60_000);

function alert(key: string, overrides: Partial<PlatformAlert> = {}): PlatformAlert {
  return {
    key,
    kind: "job",
    severity: "critical",
    message: `Mensagem de ${key}`,
    tenantId: null,
    since: null,
    href: "/admin#saude",
    ...overrides,
  };
}

function healthWith(alerts: PlatformAlert[]) {
  return { checkedAt: NOW.toISOString(), alerts, houses: [], quietHouses: [] };
}

type GetUserById = { mockImplementation: (fn: (id: string) => unknown) => void };

function seedUsers() {
  fake.admin
    .rows("user_roles")
    .push(
      { user_id: SUPER_1, tenant_id: null, role: "super_admin" },
      { user_id: SUPER_2, tenant_id: null, role: "super_admin" },
      { user_id: HOUSE_ADMIN, tenant_id: HOUSE_A, role: "admin" },
    );
  (
    fake.admin.client as unknown as { auth: { admin: { getUserById: GetUserById } } }
  ).auth.admin.getUserById.mockImplementation((id: string) => ({
    data: { user: { email: EMAIL_BY_USER[id] ?? null } },
    error: null,
  }));
}

const alertRows = () => fake.admin.rows("platform_alerts");
const openRows = () => alertRows().filter((row) => row.resolved_at == null);

beforeEach(() => {
  fake.admin.reset();
  seedUsers();
  mocks.computePlatformHealth.mockReset();
  mocks.sendPlatformEmail.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("syncPlatformAlerts", () => {
  it("first sync inserts one open row per current alert", async () => {
    mocks.computePlatformHealth.mockResolvedValue(
      healthWith([alert("job:a"), alert("queue:b", { kind: "queue", severity: "warning" })]),
    );

    const result = await syncPlatformAlerts(NOW);

    expect(result).toMatchObject({ opened: 2, seen: 0, resolved: 0 });
    expect(mocks.computePlatformHealth).toHaveBeenCalledWith(NOW);
    const open = await loadOpenAlerts();
    expect(open.map((a) => a.alertKey).sort()).toEqual(["job:a", "queue:b"]);
    const a = open.find((row) => row.alertKey === "job:a")!;
    expect(a).toMatchObject({
      kind: "job",
      severity: "critical",
      message: "Mensagem de job:a",
      seenCount: 1,
      acknowledgedAt: null,
      lastNotifiedAt: null,
    });
    expect(new Date(a.openedAt).getTime()).toBe(NOW.getTime());
  });

  it("second sync resolves the vanished alert and bumps seen_count of the other", async () => {
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("job:a"), alert("queue:b", { kind: "queue" })]),
    );
    await syncPlatformAlerts(NOW);

    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("job:a", { message: "Mensagem nova" })]),
    );
    const result = await syncPlatformAlerts(LATER);

    expect(result).toMatchObject({ opened: 0, seen: 1, resolved: 1 });
    const a = alertRows().find((row) => row.alert_key === "job:a")!;
    expect(a).toMatchObject({ seen_count: 2, message: "Mensagem nova", resolved_at: null });
    expect(new Date(String(a.last_seen_at)).getTime()).toBe(LATER.getTime());
    const b = alertRows().find((row) => row.alert_key === "queue:b")!;
    expect(new Date(String(b.resolved_at)).getTime()).toBe(LATER.getTime());
    expect((await loadOpenAlerts()).map((row) => row.alertKey)).toEqual(["job:a"]);
  });

  it("keeps an alert open when its source failed this round", async () => {
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("queue:b", { kind: "queue" })]),
    );
    await syncPlatformAlerts(NOW);

    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("source:observability_queue_metrics", { kind: "source" })]),
    );
    const result = await syncPlatformAlerts(LATER);

    expect(result.resolved).toBe(0);
    expect(
      openRows()
        .map((row) => row.alert_key)
        .sort(),
    ).toEqual(["queue:b", "source:observability_queue_metrics"]);
  });

  it("reopens a resolved key as a new row", async () => {
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([alert("job:a")]));
    await syncPlatformAlerts(NOW);
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([]));
    await syncPlatformAlerts(LATER);
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([alert("job:a")]));
    const result = await syncPlatformAlerts(new Date(LATER.getTime() + 60_000));

    expect(result.opened).toBe(1);
    expect(alertRows().filter((row) => row.alert_key === "job:a")).toHaveLength(2);
    expect(openRows()).toHaveLength(1);
  });

  it("two concurrent syncs produce one open row per key and one e-mail", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    // Both runs compute the same alerts and only proceed once both started,
    // so both read an empty table before either inserts.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    mocks.computePlatformHealth.mockImplementation(async () => {
      started += 1;
      if (started === 2) release();
      await barrier;
      return healthWith([alert("job:a"), alert("job:b")]);
    });

    const [first, second] = await Promise.all([syncPlatformAlerts(NOW), syncPlatformAlerts(NOW)]);

    expect(
      openRows()
        .map((row) => row.alert_key)
        .sort(),
    ).toEqual(["job:a", "job:b"]);
    expect(first.opened + second.opened).toBe(2);
    // One e-mail per super admin, sent by one run only.
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
    expect(first.notified + second.notified).toBe(2);
  });

  it("flag off: no e-mail and last_notified_at untouched", async () => {
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));

    const result = await syncPlatformAlerts(NOW);

    expect(result.notified).toBe(0);
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
    expect(openRows()[0].last_notified_at ?? null).toBeNull();
  });

  it("flag on: one e-mail to every super admin listing all notifiable criticals", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValue(
      healthWith([
        alert("job:a", { message: "Robô A parado" }),
        alert("provider:sms", { kind: "provider", message: "Disjuntor SMS aberto" }),
        alert("queue:b", { kind: "queue", severity: "warning", message: "Fila lenta" }),
      ]),
    );

    const result = await syncPlatformAlerts(NOW);

    expect(result.notified).toBe(2);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
    const recipients = mocks.sendPlatformEmail.mock.calls.map(([input]) => input.to).sort();
    expect(recipients).toEqual(["root1@betleads.io", "root2@betleads.io"]);
    const [{ html, subject, idempotencyKey }] = mocks.sendPlatformEmail.mock.calls[0];
    expect(subject).toContain("2 alertas críticos");
    expect(html).toContain("Robô A parado");
    expect(html).toContain("Disjuntor SMS aberto");
    expect(html).not.toContain("Fila lenta");
    expect(idempotencyKey).toEqual(expect.any(String));

    const notifiedKeys = openRows()
      .filter((row) => row.last_notified_at != null)
      .map((row) => row.alert_key)
      .sort();
    expect(notifiedKeys).toEqual(["job:a", "provider:sms"]);
  });

  it("does not renotify within CRITICAL_RENOTIFY_MS, and does after it", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));
    await syncPlatformAlerts(NOW);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);

    await syncPlatformAlerts(LATER);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);

    await syncPlatformAlerts(new Date(NOW.getTime() + CRITICAL_RENOTIFY_MS + 60_000));
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(4);
  });

  it("never e-mails an acknowledged alert", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));
    await acknowledgeAlert("job:a", SUPER_1, alert("job:a"), NOW);

    const result = await syncPlatformAlerts(NOW);

    expect(result.notified).toBe(0);
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
  });

  it(`purges resolved rows older than ${HISTORY_DAYS} days`, async () => {
    const old = new Date(NOW.getTime() - (HISTORY_DAYS + 1) * 86_400_000).toISOString();
    const recent = new Date(NOW.getTime() - 86_400_000).toISOString();
    alertRows().push(
      { id: "old", alert_key: "job:old", kind: "job", severity: "critical", resolved_at: old },
      {
        id: "recent",
        alert_key: "job:recent",
        kind: "job",
        severity: "critical",
        resolved_at: recent,
      },
    );
    mocks.computePlatformHealth.mockResolvedValue(healthWith([]));

    const result = await syncPlatformAlerts(NOW);

    expect(result.purged).toBe(1);
    expect(alertRows().map((row) => row.id)).toEqual(["recent"]);
  });
});

describe("acknowledgeAlert / silenceAlert", () => {
  it("acknowledge before the first sync creates the row from the current alert", async () => {
    await acknowledgeAlert("job:a", SUPER_1, alert("job:a"), NOW);

    const [row] = openRows();
    expect(row).toMatchObject({ alert_key: "job:a", acknowledged_by: SUPER_1, seen_count: 1 });
    expect(new Date(String(row.acknowledged_at)).getTime()).toBe(NOW.getTime());

    // The next sync sees it instead of opening a duplicate.
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));
    const result = await syncPlatformAlerts(LATER);
    expect(result).toMatchObject({ opened: 0, seen: 1 });
    expect(openRows()).toHaveLength(1);
  });

  it("silence before the first sync creates the row with silenced_until = now + SILENCE_HOURS", async () => {
    await silenceAlert("job:a", alert("job:a"), NOW);

    const [row] = openRows();
    expect(row.alert_key).toBe("job:a");
    expect(new Date(String(row.silenced_until)).getTime()).toBe(
      NOW.getTime() + SILENCE_HOURS * 3_600_000,
    );
  });

  it("updates the existing open row without inserting another", async () => {
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));
    await syncPlatformAlerts(NOW);

    await acknowledgeAlert("job:a", SUPER_2, null, LATER);
    await silenceAlert("job:a", null, LATER);

    expect(openRows()).toHaveLength(1);
    expect(openRows()[0]).toMatchObject({ acknowledged_by: SUPER_2 });
    expect(openRows()[0].silenced_until).not.toBeNull();
  });

  it("unknown key without a current alert throws", async () => {
    await expect(acknowledgeAlert("job:x", SUPER_1, null, NOW)).rejects.toThrow(
      "Alerta não encontrado.",
    );
    await expect(silenceAlert("job:x", null, NOW)).rejects.toThrow("Alerta não encontrado.");
    expect(alertRows()).toHaveLength(0);
  });
});

describe("listAlertHistory", () => {
  it(`returns resolved alerts of the last ${HISTORY_DAYS} days, newest first`, async () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const base = { kind: "job", severity: "critical", message: "m", seen_count: 1 };
    alertRows().push(
      { id: "r1", alert_key: "job:1", resolved_at: at(2), ...base },
      { id: "r2", alert_key: "job:2", resolved_at: at(1), ...base },
      { id: "old", alert_key: "job:3", resolved_at: at(HISTORY_DAYS + 1), ...base },
      { id: "open", alert_key: "job:4", resolved_at: null, ...base },
    );

    const history = await listAlertHistory(NOW);

    expect(history.map((row) => row.id)).toEqual(["r2", "r1"]);
    expect(history[0].resolvedAt).toBe(at(1));
    expect(history[0].alertKey).toBe("job:2");
  });
});
