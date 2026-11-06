import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  // Models platform_digest_log's primary key on digest_day: the second claim
  // of the same day collides (23505).
  fake.admin = createFakeDb({ unique: { platform_digest_log: [["digest_day"]] } });
  return { supabaseAdmin: fake.admin.client };
});

const mocks = vi.hoisted(() => ({
  computePlatformHealth: vi.fn(),
  loadOpenAlerts: vi.fn(),
  listSuperAdminEmails: vi.fn(),
  sendPlatformEmail: vi.fn(),
}));

vi.mock("./platform-health.server", () => ({
  computePlatformHealth: mocks.computePlatformHealth,
}));
vi.mock("./alert-store.server", () => ({
  loadOpenAlerts: mocks.loadOpenAlerts,
}));
vi.mock("./alert-email.server", () => ({
  listSuperAdminEmails: mocks.listSuperAdminEmails,
  isPlatformAlertsEmailEnabled: () => process.env.PLATFORM_ALERTS_EMAIL_ENABLED === "true",
}));
vi.mock("@/lib/billing/billing-emails.server", () => ({
  sendPlatformEmail: mocks.sendPlatformEmail,
}));

import { createFakeDb } from "@/lib/sms-bulk.test-support";

import { runDailyDigest } from "./daily-digest.server";

// 11:00 UTC = 08:00 BRT, 2026-11-05.
const NOW = new Date("2026-11-05T11:00:00.000Z");

beforeEach(() => {
  fake.admin.reset();
  mocks.computePlatformHealth.mockReset().mockResolvedValue({ houses: [] });
  mocks.loadOpenAlerts.mockReset().mockResolvedValue([]);
  mocks.listSuperAdminEmails.mockReset().mockResolvedValue(["root@betleads.io"]);
  mocks.sendPlatformEmail.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runDailyDigest", () => {
  it("flag off: disabled, no claim, no e-mail", async () => {
    const result = await runDailyDigest(NOW);

    expect(result).toEqual({ sent: false, reason: "disabled", recipients: 0 });
    expect(fake.admin.rows("platform_digest_log")).toHaveLength(0);
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
  });

  it("flag on, no super admins: no_recipients", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.listSuperAdminEmails.mockResolvedValue([]);

    const result = await runDailyDigest(NOW);

    expect(result).toEqual({ sent: false, reason: "no_recipients", recipients: 0 });
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
  });

  it("flag on with recipients: sends one e-mail per recipient and logs the day", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.listSuperAdminEmails.mockResolvedValue(["root1@betleads.io", "root2@betleads.io"]);

    const result = await runDailyDigest(NOW);

    expect(result).toEqual({ sent: true, recipients: 2 });
    expect(mocks.sendPlatformEmail).toHaveBeenCalledTimes(2);
    const calls = mocks.sendPlatformEmail.mock.calls.map(([input]) => input);
    expect(calls.map((c) => c.to).sort()).toEqual(["root1@betleads.io", "root2@betleads.io"]);
    expect(calls.map((c) => c.idempotencyKey).sort()).toEqual([
      "platform-digest:2026-11-05:0",
      "platform-digest:2026-11-05:1",
    ]);
    const [row] = fake.admin.rows("platform_digest_log");
    expect(row).toMatchObject({ digest_day: "2026-11-05", recipients: 2 });
  });

  it("second run same day: already_sent and no e-mail", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    await runDailyDigest(NOW);
    mocks.sendPlatformEmail.mockClear();

    const result = await runDailyDigest(NOW);

    expect(result).toEqual({ sent: false, reason: "already_sent", recipients: 0 });
    expect(mocks.sendPlatformEmail).not.toHaveBeenCalled();
    expect(fake.admin.rows("platform_digest_log")).toHaveLength(1);
  });

  it("pulls debtors from tenant_billing + open billing_invoices for the health houses", async () => {
    vi.stubEnv("PLATFORM_ALERTS_EMAIL_ENABLED", "true");
    mocks.computePlatformHealth.mockResolvedValue({
      houses: [
        {
          tenantId: "t1",
          name: "Casa Devedora",
          moeda: "BRL",
          level: "red",
          reason: "Cadastros -60%",
          current: { registrations: 0, ftds: 0, recovered: 0, conversion: null },
          base: { registrations: 0, ftds: 0, recovered: 0, conversion: null },
          deltas: {
            registrationsPct: null,
            ftdsPct: null,
            conversionPts: null,
            recoveredPct: null,
          },
          worstDelta: null,
        },
      ],
    });
    fake.admin.rows("tenant_billing").push({ tenant_id: "t1", access_state: "overdue" });
    fake.admin
      .rows("billing_invoices")
      .push({ tenant_id: "t1", status: "open", amount_cents: 400000, due_date: "2026-10-01" });

    await runDailyDigest(NOW);

    const [{ html }] = mocks.sendPlatformEmail.mock.calls[0];
    expect(html).toContain("Casa Devedora");
  });
});
