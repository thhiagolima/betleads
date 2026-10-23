import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  (fake.admin.client as unknown as { auth: unknown }).auth = {
    admin: { getUserById: vi.fn() },
  };
  return { supabaseAdmin: fake.admin.client };
});

const { callInfobipEmail } = vi.hoisted(() => ({ callInfobipEmail: vi.fn() }));
vi.mock("../infobip-email.server", () => ({ callInfobipEmail }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  CANDIDATES_PAGE_SIZE,
  claimWalletAlert,
  LOW_BALANCE_ALERT_INTERVAL,
  NO_BALANCE_ALERT_INTERVAL,
  notifyNoBalance,
  resetNoBalanceAlertMemo,
  sendLowBalanceAlerts,
} from "./wallet-alerts.server";

const HOUSE_A = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_B = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-000000000001";
const GESTOR_A = "00000000-0000-4000-8000-000000000002";
const MEMBER_A = "00000000-0000-4000-8000-000000000003";
const ADMIN_B = "00000000-0000-4000-8000-000000000004";

const EMAIL_BY_USER: Record<string, string> = {
  [ADMIN_A]: "admin@casa-a.com",
  [GESTOR_A]: "gestor@casa-a.com",
  [MEMBER_A]: "member@casa-a.com",
  [ADMIN_B]: "admin@casa-b.com",
};

// 12:00 BRT (inside 08:00-20:00) and 21:00 BRT (outside).
const INSIDE_WINDOW = new Date("2026-10-23T15:00:00.000Z");
const OUTSIDE_WINDOW = new Date("2026-10-24T00:00:00.000Z");

type GetUserById = { mockImplementation: (fn: (id: string) => unknown) => void };

function seedUsers() {
  fake.admin
    .rows("user_roles")
    .push(
      { user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin" },
      { user_id: GESTOR_A, tenant_id: HOUSE_A, role: "gestor" },
      { user_id: MEMBER_A, tenant_id: HOUSE_A, role: "member" },
      { user_id: ADMIN_B, tenant_id: HOUSE_B, role: "admin" },
    );
  (
    fake.admin.client as unknown as { auth: { admin: { getUserById: GetUserById } } }
  ).auth.admin.getUserById.mockImplementation((id: string) => ({
    data: { user: { email: EMAIL_BY_USER[id] ?? null } },
    error: null,
  }));
}

function candidatesRpc(
  rows: Array<{
    tenant_id: string;
    tenant_name: string;
    balance: number;
    low_balance_threshold: number;
  }>,
) {
  // Emulates the SQL keyset paging: tenant_id order, `_after`, `_limit`.
  const sorted = [...rows].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
  const rpc = vi.fn((args: Record<string, unknown>) => {
    const after = (args._after as string | null) ?? null;
    const page = sorted
      .filter((row) => after === null || row.tenant_id > after)
      .slice(0, args._limit as number);
    return { data: page, error: null };
  });
  fake.admin.onRpc("billing_low_balance_candidates", rpc);
  return rpc;
}

beforeEach(() => {
  fake.admin.reset();
  callInfobipEmail.mockReset();
  callInfobipEmail.mockResolvedValue({ ok: true, status: 200, idempotencyKey: "k" });
  seedUsers();
  resetNoBalanceAlertMemo();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimWalletAlert", () => {
  it("calls billing_claim_wallet_alert and returns its boolean", async () => {
    const rpc = vi.fn(() => ({ data: true, error: null }));
    fake.admin.onRpc("billing_claim_wallet_alert", rpc);
    await expect(claimWalletAlert(HOUSE_A, "no_balance", "1 hour")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith({
      _tenant: HOUSE_A,
      _kind: "no_balance",
      _interval: "1 hour",
    });
    fake.admin.onRpc("billing_claim_wallet_alert", () => ({ data: false, error: null }));
    await expect(claimWalletAlert(HOUSE_A, "low_balance", "24 hours")).resolves.toBe(false);
  });

  it("throws on an RPC error", async () => {
    fake.admin.onRpc("billing_claim_wallet_alert", () => ({
      data: null,
      error: { message: "boom" },
    }));
    await expect(claimWalletAlert(HOUSE_A, "low_balance", "24 hours")).rejects.toThrow("boom");
  });
});

describe("sendLowBalanceAlerts", () => {
  it("does nothing outside the 08:00-20:00 Brasília window", async () => {
    const rpc = candidatesRpc([]);
    await expect(sendLowBalanceAlerts({ now: OUTSIDE_WINDOW })).resolves.toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("claims 'low_balance' for 24 hours and e-mails only the payers of the houses it won", async () => {
    candidatesRpc([
      { tenant_id: HOUSE_A, tenant_name: "Casa <A>", balance: 199.99, low_balance_threshold: 200 },
      { tenant_id: HOUSE_B, tenant_name: "Casa B", balance: 10, low_balance_threshold: 200 },
    ]);
    const claim = vi.fn((args: Record<string, unknown>) => ({
      data: args._tenant === HOUSE_A,
      error: null,
    }));
    fake.admin.onRpc("billing_claim_wallet_alert", claim);

    await expect(sendLowBalanceAlerts({ now: INSIDE_WINDOW })).resolves.toBe(1);

    expect(LOW_BALANCE_ALERT_INTERVAL).toBe("24 hours");
    expect(claim).toHaveBeenCalledWith({
      _tenant: HOUSE_A,
      _kind: "low_balance",
      _interval: "24 hours",
    });
    expect(claim).toHaveBeenCalledWith({
      _tenant: HOUSE_B,
      _kind: "low_balance",
      _interval: "24 hours",
    });
    const recipients = callInfobipEmail.mock.calls.map((call) => call[0].to).sort();
    expect(recipients).toEqual(["admin@casa-a.com", "gestor@casa-a.com"]);

    const sent = callInfobipEmail.mock.calls[0][0];
    expect(sent.subject).toBe("Saldo baixo na BetLeads: R$ 199,99");
    expect(sent.html).toContain("R$ 199,99");
    expect(sent.html).toContain("R$ 200,00");
    expect(sent.html).toContain("https://betleads.io/plano-e-creditos");
    expect(sent.html).toContain(
      "SMS e voz ficam bloqueados; e-mail segue só dentro da franquia mensal.",
    );
    expect(sent.html).toContain("Casa &lt;A&gt;");
    expect(sent.html).not.toContain("<A>");
    expect(sent.html).not.toContain(String.fromCharCode(160));
    expect(sent.idempotencyKey).toMatch(/^wallet-alert:low_balance:/);
  });

  it("pages through every candidate, past PostgREST's 1000-row cap", async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({
      tenant_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      tenant_name: `Casa ${i}`,
      balance: 5,
      low_balance_threshold: 200,
    }));
    const rpc = candidatesRpc(rows);
    const claim = vi.fn(() => ({ data: false, error: null }));
    fake.admin.onRpc("billing_claim_wallet_alert", claim);

    await expect(sendLowBalanceAlerts({ now: INSIDE_WINDOW })).resolves.toBe(0);

    expect(CANDIDATES_PAGE_SIZE).toBe(500);
    expect(claim).toHaveBeenCalledTimes(1201);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      { _after: null, _limit: 500 },
      { _after: rows[499].tenant_id, _limit: 500 },
      { _after: rows[999].tenant_id, _limit: 500 },
    ]);
  });

  it("one house failing does not stop the next", async () => {
    candidatesRpc([
      { tenant_id: HOUSE_A, tenant_name: "Casa A", balance: 5, low_balance_threshold: 200 },
      { tenant_id: HOUSE_B, tenant_name: "Casa B", balance: 5, low_balance_threshold: 200 },
    ]);
    fake.admin.onRpc("billing_claim_wallet_alert", (args) =>
      args._tenant === HOUSE_A
        ? { data: null, error: { message: "claim failed" } }
        : { data: true, error: null },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendLowBalanceAlerts({ now: INSIDE_WINDOW })).resolves.toBe(1);
    expect(callInfobipEmail.mock.calls.map((call) => call[0].to)).toEqual(["admin@casa-b.com"]);
  });

  it("counts a house only when at least one recipient was accepted", async () => {
    candidatesRpc([
      { tenant_id: HOUSE_B, tenant_name: "Casa B", balance: 5, low_balance_threshold: 200 },
    ]);
    fake.admin.onRpc("billing_claim_wallet_alert", () => ({ data: true, error: null }));
    callInfobipEmail.mockResolvedValue({ ok: false, status: 500, idempotencyKey: "k" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendLowBalanceAlerts({ now: INSIDE_WINDOW })).resolves.toBe(0);
  });

  it("throws when the candidate list cannot be read (runBillingCycle records it)", async () => {
    fake.admin.onRpc("billing_low_balance_candidates", () => ({
      data: null,
      error: { message: "timeout" },
    }));
    await expect(sendLowBalanceAlerts({ now: INSIDE_WINDOW })).rejects.toThrow("timeout");
  });
});

describe("notifyNoBalance (Task 7: a send refused for lack of balance)", () => {
  function seedHouse(id: string, extra: Record<string, unknown> = {}) {
    fake.admin.rows("tenants").push({ id, nome: "Casa <A>", is_demo: false, ...extra });
  }

  /** Emulates billing_claim_wallet_alert: true once per (tenant, kind) until reset. */
  function claimOncePerInterval() {
    const claimed = new Set<string>();
    const claim = vi.fn((args: Record<string, unknown>) => {
      const key = `${args._tenant}:${args._kind}`;
      if (claimed.has(key)) return { data: false, error: null };
      claimed.add(key);
      return { data: true, error: null };
    });
    fake.admin.onRpc("billing_claim_wallet_alert", claim);
    return claim;
  }

  beforeEach(() => {
    fake.admin.onRpc("billing_tenant_exempt", () => ({ data: false, error: null }));
  });

  it("claims 'no_balance' for 1 hour and e-mails the admins/gestores", async () => {
    seedHouse(HOUSE_A);
    const claim = claimOncePerInterval();

    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(true);

    expect(NO_BALANCE_ALERT_INTERVAL).toBe("1 hour");
    expect(claim).toHaveBeenCalledWith({
      _tenant: HOUSE_A,
      _kind: "no_balance",
      _interval: "1 hour",
    });
    const recipients = callInfobipEmail.mock.calls.map((call) => call[0].to).sort();
    expect(recipients).toEqual(["admin@casa-a.com", "gestor@casa-a.com"]);
    const sent = callInfobipEmail.mock.calls[0][0];
    expect(sent.subject).toBe("Saldo esgotado — envios pausados");
    expect(sent.html).toContain("https://betleads.io/plano-e-creditos");
    expect(sent.html).toContain("SMS e voz estão pausados");
    expect(sent.html).toContain("e-mail segue só dentro da franquia mensal gratuita");
    expect(sent.html).toContain("Casa &lt;A&gt;");
    expect(sent.html).not.toContain(String.fromCharCode(160));
    expect(sent.idempotencyKey).toMatch(/^wallet-alert:no_balance:/);
  });

  it("two failures within the hour send 1 alert", async () => {
    seedHouse(HOUSE_A);
    claimOncePerInterval();

    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(true);
    const later = new Date(INSIDE_WINDOW.getTime() + 10 * 60_000);
    await expect(notifyNoBalance(HOUSE_A, { now: later })).resolves.toBe(false);

    expect(callInfobipEmail).toHaveBeenCalledTimes(2); // one e-mail, two recipients
  });

  it("outside the 08:00-20:00 window: 0 alerts and no claim, so a failure inside the window still claims", async () => {
    seedHouse(HOUSE_A);
    const claim = claimOncePerInterval();

    await expect(notifyNoBalance(HOUSE_A, { now: OUTSIDE_WINDOW })).resolves.toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(callInfobipEmail).not.toHaveBeenCalled();

    const nextMorning = new Date("2026-10-24T12:00:00.000Z"); // 09:00 BRT
    await expect(notifyNoBalance(HOUSE_A, { now: nextMorning })).resolves.toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("a demo house never alerts", async () => {
    seedHouse(HOUSE_A, { is_demo: true });
    const claim = claimOncePerInterval();
    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("an exempt house never alerts", async () => {
    seedHouse(HOUSE_A);
    fake.admin.onRpc("billing_tenant_exempt", () => ({ data: true, error: null }));
    const claim = claimOncePerInterval();
    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(callInfobipEmail).not.toHaveBeenCalled();
  });

  it("never throws: a DB or provider failure is logged and returns false", async () => {
    seedHouse(HOUSE_A);
    fake.admin.onRpc("billing_claim_wallet_alert", () => ({
      data: null,
      error: { message: "db down" },
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(false);
    expect(logged).toHaveBeenCalled();

    resetNoBalanceAlertMemo();
    claimOncePerInterval();
    callInfobipEmail.mockRejectedValue(new Error("smtp down"));
    await expect(notifyNoBalance(HOUSE_A, { now: INSIDE_WINDOW })).resolves.toBe(false);
  });

  it("a burst of failures from one house asks the database once per minute at most", async () => {
    seedHouse(HOUSE_A);
    const claim = vi.fn(() => ({ data: false, error: null }));
    fake.admin.onRpc("billing_claim_wallet_alert", claim);

    for (let i = 0; i < 50; i += 1) {
      await notifyNoBalance(HOUSE_A, { now: new Date(INSIDE_WINDOW.getTime() + i * 1000) });
    }
    expect(claim).toHaveBeenCalledTimes(1);
    await notifyNoBalance(HOUSE_A, { now: new Date(INSIDE_WINDOW.getTime() + 61_000) });
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
