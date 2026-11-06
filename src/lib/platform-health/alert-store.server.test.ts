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
import {
  CRITICAL_RENOTIFY_MS,
  HISTORY_DAYS,
  RESOLVE_GRACE_MS,
  SILENCE_HOURS,
} from "./alert-lifecycle";
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
/** First round after RESOLVE_GRACE_MS: an alert last seen at NOW and absent now resolves. */
const AFTER_GRACE = new Date(NOW.getTime() + RESOLVE_GRACE_MS + 5 * 60_000);
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

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
    const result = await syncPlatformAlerts(AFTER_GRACE);

    expect(result).toMatchObject({ opened: 0, seen: 1, resolved: 1 });
    const a = alertRows().find((row) => row.alert_key === "job:a")!;
    expect(a).toMatchObject({ seen_count: 2, message: "Mensagem nova", resolved_at: null });
    expect(new Date(String(a.last_seen_at)).getTime()).toBe(AFTER_GRACE.getTime());
    const b = alertRows().find((row) => row.alert_key === "queue:b")!;
    expect(new Date(String(b.resolved_at)).getTime()).toBe(AFTER_GRACE.getTime());
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
    const result = await syncPlatformAlerts(AFTER_GRACE);

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
    await syncPlatformAlerts(AFTER_GRACE);
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([alert("job:a")]));
    const result = await syncPlatformAlerts(new Date(AFTER_GRACE.getTime() + 60_000));

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

  it("a failed tenants source keeps every per-house alert open and sends no new e-mail", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    const perHouse = [
      alert(`webhook:${HOUSE_A}:silence`, { kind: "webhook", tenantId: HOUSE_A }),
      alert(`queue:${HOUSE_A}:sms`, { kind: "queue", tenantId: HOUSE_A }),
      alert(`runway:${HOUSE_A}:zero`, { kind: "runway", tenantId: HOUSE_A }),
    ];
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith(perHouse));
    await syncPlatformAlerts(NOW);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);

    // The house set is empty: no per-house rule can fire, which proves nothing.
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("source:tenants", { kind: "source", severity: "warning" })]),
    );
    const result = await syncPlatformAlerts(AFTER_GRACE);

    expect(result.resolved).toBe(0);
    expect(
      openRows()
        .map((row) => row.alert_key)
        .sort(),
    ).toEqual([...perHouse.map((a) => a.key), "source:tenants"].sort());

    // Houses come back: same rows, still inside the renotify window, no e-mail.
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith(perHouse));
    const back = await syncPlatformAlerts(new Date(AFTER_GRACE.getTime() + 5 * 60_000));
    expect(back.opened).toBe(0);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
  });

  it("a failed finance_days source keeps webhook alerts open", async () => {
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert(`webhook:${HOUSE_A}:silence`, { kind: "webhook" })]),
    );
    await syncPlatformAlerts(NOW);
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("source:finance_days", { kind: "source", severity: "warning" })]),
    );

    const result = await syncPlatformAlerts(AFTER_GRACE);

    expect(result.resolved).toBe(0);
    expect(openRows().map((row) => row.alert_key)).toContain(`webhook:${HOUSE_A}:silence`);
  });

  it("a key absent one round and back keeps its row and sends no new e-mail", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([alert("job:a")]));
    await syncPlatformAlerts(NOW);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);

    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([]));
    const absent = await syncPlatformAlerts(LATER);
    expect(absent.resolved).toBe(0);

    mocks.computePlatformHealth.mockResolvedValueOnce(healthWith([alert("job:a")]));
    const back = await syncPlatformAlerts(new Date(LATER.getTime() + 5 * 60_000));

    expect(back).toMatchObject({ opened: 0, seen: 1, resolved: 0 });
    expect(alertRows().filter((row) => row.alert_key === "job:a")).toHaveLength(1);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
  });

  it("reopening a key resolved 1 h ago carries its notification and silence: no e-mail", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    alertRows().push(
      {
        id: "older",
        alert_key: "job:a",
        kind: "job",
        severity: "critical",
        resolved_at: at(-3 * HOUR),
        last_notified_at: at(-20 * HOUR),
        silenced_until: null,
      },
      {
        id: "recent",
        alert_key: "job:a",
        kind: "job",
        severity: "critical",
        resolved_at: at(-1 * HOUR),
        last_notified_at: at(-2 * HOUR),
        silenced_until: at(10 * HOUR),
      },
    );
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));

    const result = await syncPlatformAlerts(NOW);

    expect(result).toMatchObject({ opened: 1, notified: 0 });
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
    const [row] = openRows();
    expect(row.last_notified_at).toBe(at(-2 * HOUR));
    expect(row.silenced_until).toBe(at(10 * HOUR));
  });

  it("reopening a key resolved 1 h ago carries last_notified_at but not an expired silence", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    alertRows().push({
      id: "recent",
      alert_key: "job:a",
      kind: "job",
      severity: "critical",
      resolved_at: at(-1 * HOUR),
      last_notified_at: at(-2 * HOUR),
      silenced_until: at(-30 * 60_000),
    });
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));

    await syncPlatformAlerts(NOW);

    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
    const [row] = openRows();
    expect(row.last_notified_at).toBe(at(-2 * HOUR));
    expect(row.silenced_until ?? null).toBeNull();
  });

  it("reopening a key resolved 7 h ago starts fresh and e-mails", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    alertRows().push({
      id: "old",
      alert_key: "job:a",
      kind: "job",
      severity: "critical",
      resolved_at: at(-7 * HOUR),
      last_notified_at: at(-8 * HOUR),
      silenced_until: at(10 * HOUR),
    });
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));

    const result = await syncPlatformAlerts(NOW);

    expect(result.notified).toBe(2);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
  });

  it("an acknowledged warning that escalates to critical loses its acknowledgement and e-mails", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("queue:b", { kind: "queue", severity: "warning" })]),
    );
    await syncPlatformAlerts(NOW);
    await acknowledgeAlert("queue:b", SUPER_1, null, NOW);

    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("queue:b", { kind: "queue", severity: "critical" })]),
    );
    const result = await syncPlatformAlerts(LATER);

    expect(result.notified).toBe(2);
    const [row] = openRows();
    expect(row).toMatchObject({
      severity: "critical",
      acknowledged_at: null,
      acknowledged_by: null,
    });
  });

  it("an escalation keeps an explicit silence", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("queue:b", { kind: "queue", severity: "warning" })]),
    );
    await syncPlatformAlerts(NOW);
    await silenceAlert("queue:b", null, NOW);

    mocks.computePlatformHealth.mockResolvedValueOnce(
      healthWith([alert("queue:b", { kind: "queue", severity: "critical" })]),
    );
    const result = await syncPlatformAlerts(LATER);

    expect(result.notified).toBe(0);
    expect(openRows()[0].silenced_until).not.toBeNull();
  });

  it("no super admin e-mail: nothing is claimed, logged once", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.admin.rows("user_roles").length = 0;
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a"), alert("job:b")]));

    const result = await syncPlatformAlerts(NOW);

    expect(result.notified).toBe(0);
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
    expect(openRows().every((row) => row.last_notified_at == null)).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("recipient lookup failure: nothing is claimed, the sync still purges", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    alertRows().push({
      id: "old",
      alert_key: "job:old",
      kind: "job",
      severity: "critical",
      resolved_at: new Date(NOW.getTime() - (HISTORY_DAYS + 1) * 86_400_000).toISOString(),
    });
    fake.admin.failNext("user_roles", "select", "roles down");
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));

    const result = await syncPlatformAlerts(NOW);

    expect(result).toMatchObject({ opened: 1, notified: 0, purged: 1 });
    expect(openRows()[0].last_notified_at ?? null).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[platform-alerts]"),
      expect.objectContaining({ error: "roles down" }),
    );
    errorSpy.mockRestore();
  });

  it("every send failing releases the claims, so the next round e-mails again", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notifiedAt = at(-7 * HOUR);
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a"), alert("job:b")]));
    await syncPlatformAlerts(NOW);
    // job:b was notified 7 h ago (due again); job:a never.
    const a = alertRows().find((row) => row.alert_key === "job:a")!;
    const b = alertRows().find((row) => row.alert_key === "job:b")!;
    a.last_notified_at = null;
    b.last_notified_at = notifiedAt;
    mocks.sendPlatformEmail.mockReset().mockResolvedValue({ ok: false, status: 503 });

    const failed = await syncPlatformAlerts(LATER);

    expect(failed.notified).toBe(0);
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
    expect(a.last_notified_at ?? null).toBeNull();
    expect(b.last_notified_at).toBe(notifiedAt);

    mocks.sendPlatformEmail.mockReset().mockResolvedValue({ ok: true, status: 200 });
    const retry = await syncPlatformAlerts(new Date(LATER.getTime() + 5 * 60_000));
    expect(retry.notified).toBe(2);
    expect(String(a.last_notified_at)).not.toBe("null");
    errorSpy.mockRestore();
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

  it("acknowledging an alert resolved in between throws 'Alerta já resolvido.'", async () => {
    mocks.computePlatformHealth.mockResolvedValue(healthWith([alert("job:a")]));
    await syncPlatformAlerts(NOW);
    // The cron resolves the row between the open-row check and the update.
    const client = fake.admin.client as unknown as { from: (table: string) => unknown };
    const realFrom = client.from;
    let calls = 0;
    const spy = vi.spyOn(client, "from").mockImplementation((table: string) => {
      calls += 1;
      if (calls === 2) for (const row of openRows()) row.resolved_at = LATER.toISOString();
      return realFrom(table);
    });

    await expect(acknowledgeAlert("job:a", SUPER_1, null, LATER)).rejects.toThrow(
      "Alerta já resolvido.",
    );
    await expect(silenceAlert("job:a", null, LATER)).rejects.toThrow("Alerta não encontrado.");
    spy.mockRestore();
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
