// PG3 Task 6 — sendInfobipEmail reserves 1 e-mail from the house's wallet
// (after the monthly free allowance, counted in SQL) before calling Infobip.
//
// Runs the real send guard and the real reserveForDelivery against an
// in-memory database (wallet_reserve/wallet_refund stand-ins from
// installCreditLedger); consent, suppression, link tracking and the
// provider adapter are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

const mocks = vi.hoisted(() => ({
  consent: vi.fn(async (): Promise<string | null> => null),
  suppressed: vi.fn(async () => false),
  provider: vi.fn(),
  markSent: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  // findAcceptedEmail filters with PostgREST `.or(...)`, which the fake DB
  // does not model: no earlier accepted send in these tests.
  const noAcceptedSend: any = {
    select: () => noAcceptedSend,
    eq: () => noAcceptedSend,
    or: () => noAcceptedSend,
    limit: async () => ({ data: [], error: null }),
  };
  return {
    supabaseAdmin: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        fake.rpcCalls.push({ fn, args });
        return fake.db.client.rpc(fn, args);
      },
      from: (table: string) =>
        table === "email_send_logs" ? noAcceptedSend : fake.db.client.from(table),
    },
  };
});
vi.mock("./consent.server", () => ({ getChannelConsentStatus: mocks.consent }));
vi.mock("./email-deliverability.server", () => ({
  augmentEmailHtml: vi.fn(async (html: string) => ({ html, unsubscribeUrl: null })),
  isSuppressed: mocks.suppressed,
}));
vi.mock("./infobip-email.server", () => ({ callInfobipEmail: mocks.provider }));
vi.mock("./shortio.server", () => ({
  prepareTrackedEmailHtml: vi.fn(async (content: string) => ({
    content,
    links: [{ dispatchId: "dispatch-1" }],
  })),
  markTrackedDispatchesSent: mocks.markSent,
  markTrackedDispatchesFailed: mocks.markFailed,
}));

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { sendInfobipEmail, type SendEmailInput } from "./email-send.server";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const LOCKED = "00000000-0000-4000-8000-000000000003";

let wallet: ReturnType<typeof installCreditLedger>;
let balanceUnits: number;

const input = (overrides: Partial<SendEmailInput> = {}): SendEmailInput => ({
  to: "jogador@example.test",
  from: "casa@example.test",
  subject: "Oi",
  html: "<p>Oi</p>",
  tenantId: NORMAL,
  linkTracking: {
    tenantId: NORMAL,
    sourceType: "campaign",
    messageLogType: "email_send_logs",
  },
  ...overrides,
});

const accepted = (key = "k") => ({
  ok: true,
  status: 200,
  body: { messages: [{ messageId: "m-1" }] },
  idempotencyKey: key,
  temporary: false,
});

beforeEach(() => {
  fake.db.reset();
  fake.rpcCalls.length = 0;
  __resetDemoTenantCacheForTests();
  fake.db.rows("tenants").push(
    { id: NORMAL, status: "active", is_demo: false },
    { id: DEMO, status: "active", is_demo: true },
    { id: LOCKED, status: "active", is_demo: false, tenant_billing: { access_state: "frozen" } },
  );
  balanceUnits = 1000;
  wallet = installCreditLedger(fake.db, { balance: () => balanceUnits });
  mocks.consent.mockReset().mockResolvedValue(null);
  mocks.suppressed.mockReset().mockResolvedValue(false);
  mocks.provider.mockReset().mockImplementation(async (i: { idempotencyKey: string }) =>
    accepted(i.idempotencyKey),
  );
  mocks.markSent.mockClear();
  mocks.markFailed.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reservations = () =>
  wallet.ledger().filter((row) => row.entry_type === "usage_reservation");
const refunds = () => wallet.ledger().filter((row) => row.entry_type === "usage_refund");

describe("sendInfobipEmail wallet reservation", () => {
  it("reserves 1 e-mail under the email keys before sending and returns billing", async () => {
    const result = await sendInfobipEmail(input({ idempotencyKey: "journey-key-1" }));
    expect(result.ok).toBe(true);
    expect(mocks.provider).toHaveBeenCalledTimes(1);
    const seen = fake.rpcCalls.filter((c) => c.fn === "wallet_reserve").map((c) => c.args);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      _tenant: NORMAL,
      _item: "email",
      _units: 1,
      _reference_type: "email_send",
      _reference_id: "email:journey-key-1",
      _idempotency_key: "email-reserve:email:journey-key-1",
    });
    expect(result.billing?.referenceId).toBe("email:journey-key-1");
    expect(result.billing?.amount).toBeCloseTo(0.08, 4);
    expect(refunds()).toHaveLength(0);
  });

  it("without a caller key, the delivery key is the generated idempotency key", async () => {
    const result = await sendInfobipEmail(input());
    expect(result.ok).toBe(true);
    expect(reservations()).toHaveLength(1);
    expect(reservations()[0].reference_id).toBe(`email:${result.idempotencyKey}`);
    expect(result.billing?.referenceId).toBe(`email:${result.idempotencyKey}`);
  });

  it("a free e-mail (inside the monthly allowance) reports amount 0", async () => {
    fake.db.onRpc("wallet_reserve", () => ({
      data: { ok: true, idempotent: false, amount: 0, balance: 0 },
      error: null,
    }));
    const result = await sendInfobipEmail(input());
    expect(result.ok).toBe(true);
    expect(result.billing?.amount).toBe(0);
  });

  it("without balance: does not send and returns insufficient_balance (not temporary)", async () => {
    balanceUnits = 0;
    const result = await sendInfobipEmail(input({ idempotencyKey: "journey-key-2" }));
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 0,
      temporary: false,
      errorKind: "insufficient_balance",
      idempotencyKey: "journey-key-2",
    });
    expect(result.billing).toBeUndefined();
    expect(mocks.markFailed).toHaveBeenCalledWith(["dispatch-1"]);
  });

  it("refunds the reservation when Infobip answers 4xx", async () => {
    mocks.provider.mockResolvedValueOnce({
      ok: false,
      status: 400,
      body: { requestError: { serviceException: { text: "Bad request" } } },
      idempotencyKey: "journey-key-3",
      temporary: false,
    });
    const result = await sendInfobipEmail(input({ idempotencyKey: "journey-key-3" }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(reservations()).toHaveLength(1);
    expect(refunds()).toHaveLength(1);
    expect(refunds()[0]).toMatchObject({
      reference_id: "email:journey-key-3",
      idempotency_key: "email-refund:email:journey-key-3",
    });
    expect(wallet.charged()).toBe(0);
    expect(result.billing).toEqual({ referenceId: "email:journey-key-3", amount: 0 });
  });

  it("refunds on a transport error (timeout)", async () => {
    mocks.provider.mockResolvedValueOnce({
      ok: false,
      status: 0,
      body: { error: "timed out" },
      idempotencyKey: "k",
      temporary: true,
      errorKind: "timeout",
    });
    const result = await sendInfobipEmail(input());
    expect(result.ok).toBe(false);
    expect(refunds()).toHaveLength(1);
    expect(wallet.charged()).toBe(0);
  });

  it("refunds and rethrows when the provider call throws", async () => {
    mocks.provider.mockRejectedValueOnce(new Error("boom"));
    await expect(sendInfobipEmail(input())).rejects.toThrow("boom");
    expect(reservations()).toHaveLength(1);
    expect(refunds()).toHaveLength(1);
    expect(wallet.charged()).toBe(0);
  });

  it("a retry of the same key after a refunded failure reserves the next generation", async () => {
    mocks.provider.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: {},
      idempotencyKey: "journey-key-4",
      temporary: true,
    });
    const first = await sendInfobipEmail(input({ idempotencyKey: "journey-key-4" }));
    expect(first.ok).toBe(false);
    const retry = await sendInfobipEmail(input({ idempotencyKey: "journey-key-4" }));
    expect(retry.ok).toBe(true);
    expect(retry.billing?.referenceId).toBe("email:journey-key-4:1");
    expect(wallet.charged()).toBe(1);
  });

  it("a recipient with revoked consent is never reserved", async () => {
    mocks.consent.mockResolvedValue("revoked");
    const result = await sendInfobipEmail(input());
    expect(result).toMatchObject({ ok: false, body: { suppressed: true } });
    expect(wallet.ledger()).toHaveLength(0);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("a suppressed recipient is never reserved", async () => {
    mocks.suppressed.mockResolvedValue(true);
    const result = await sendInfobipEmail(input());
    expect(result).toMatchObject({ ok: false, body: { suppressed: true } });
    expect(wallet.ledger()).toHaveLength(0);
  });

  it("a failed consent lookup (deferred) is never reserved", async () => {
    mocks.consent.mockRejectedValue(new Error("timeout"));
    const result = await sendInfobipEmail(input());
    expect(result).toMatchObject({ ok: false, errorKind: "not_sent" });
    expect(wallet.ledger()).toHaveLength(0);
  });

  it("a demo house never reserves", async () => {
    await expect(
      sendInfobipEmail(input({ tenantId: DEMO, linkTracking: undefined })),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(wallet.ledger()).toHaveLength(0);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("a locked house never reserves", async () => {
    await expect(
      sendInfobipEmail(input({ tenantId: LOCKED, linkTracking: undefined })),
    ).rejects.toThrow();
    expect(wallet.ledger()).toHaveLength(0);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
