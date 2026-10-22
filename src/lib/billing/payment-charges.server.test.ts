import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { getUpperCharge } = vi.hoisted(() => ({ getUpperCharge: vi.fn() }));
vi.mock("./upper-pix.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upper-pix.server")>();
  return { ...actual, getUpperCharge };
});

const { sendBillingEmail } = vi.hoisted(() => ({ sendBillingEmail: vi.fn() }));
vi.mock("./billing-emails.server", () => ({ sendBillingEmail }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  confirmChargeFromUpper,
  reconcilePendingCharges,
  recordChargeSnapshot,
} from "./payment-charges.server";
import { UpperError, type UpperCharge } from "./upper-pix.server";
import {
  __resetDemoTenantCacheForTests,
  assertTenantNotDemoForSend,
} from "@/lib/tenant-access.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

function chargeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "charge-1",
    tenant_id: TENANT,
    kind: "credit_topup",
    ref_id: "order-1",
    external_id: "bl-top-order-1",
    amount_cents: 50000,
    status: "ACTIVE",
    needs_review: false,
    ...overrides,
  };
}

function upperCharge(overrides: Partial<UpperCharge> = {}): UpperCharge {
  return {
    id: "upstream-1",
    externalId: "bl-top-order-1",
    status: "ACTIVE",
    amountCents: 50000,
    emv: null,
    qrCodeImage: null,
    paymentUrl: null,
    expiresAt: null,
    paidAt: null,
    paidAmountCents: null,
    payer: null,
    raw: { status: "ACTIVE" },
    ...overrides,
  };
}

/**
 * Realistic stand-in for billing_credit_paid_charge: credits only a row that
 * is PAID, not yet credited, not flagged and with a matching paid amount.
 */
function installCreditRpc() {
  const rpc = vi.fn((args: Record<string, unknown>) => {
    const row = fake.admin.rows("payment_charges").find((r) => r.id === args._charge_id);
    if (!row) return { data: null, error: { message: "charge_not_found" } };
    if (row.credited_at) return { data: { ok: true, idempotent: true }, error: null };
    if (row.status !== "PAID") return { data: { ok: false, reason: "not_paid" }, error: null };
    if (row.needs_review) return { data: { ok: false, reason: "needs_review" }, error: null };
    if (row.paid_amount_cents !== row.amount_cents) {
      return { data: { ok: false, reason: "amount_mismatch" }, error: null };
    }
    row.credited_at = new Date().toISOString();
    return { data: { ok: true }, error: null };
  });
  fake.admin.onRpc("billing_credit_paid_charge", rpc);
  return rpc;
}

/**
 * Simulates a concurrent writer: right when the code under test issues its
 * `payment_charges` update carrying `status = whenStatus`, the row is first
 * flipped to PAID (as a PAID webhook snapshot landing between our read and
 * our write would). The conditional update must then match nothing.
 */
function racePaidBeforeUpdate(chargeId: string, whenStatus: string) {
  type Builder = Record<string, (...args: unknown[]) => unknown>;
  const client = fake.admin.client as unknown as { from: (table: string) => Builder };
  const originalFrom = client.from;
  vi.spyOn(client, "from").mockImplementation((table: string) => {
    const builder = originalFrom(table);
    if (table !== "payment_charges") return builder;
    const originalUpdate = builder.update;
    builder.update = (value: unknown) => {
      if ((value as { status?: string }).status === whenStatus) {
        const row = fake.admin.rows("payment_charges").find((r) => r.id === chargeId);
        if (row) {
          row.status = "PAID";
          row.paid_amount_cents = row.amount_cents;
        }
      }
      return originalUpdate(value);
    };
    return builder;
  });
}

beforeEach(() => {
  fake.admin.reset();
  getUpperCharge.mockReset();
  sendBillingEmail.mockReset();
  sendBillingEmail.mockResolvedValue({ sent: true, recipients: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordChargeSnapshot", () => {
  it("updates status, paid fields, masked payer info and never writes the full document", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({
        status: "PAID",
        paidAmountCents: 50000,
        paidAt: "2026-10-22T12:00:00Z",
        payer: { name: "Fulano da Silva", document: "123.456.789-09" },
        raw: {
          status: "PAID",
          payer: { name: "Fulano da Silva", document: "123.456.789-09" },
        },
      }),
    );

    const row = fake.admin.rows("payment_charges")[0];
    expect(row.status).toBe("PAID");
    expect(row.paid_amount_cents).toBe(50000);
    expect(row.payer_name).toBe("Fulano da Silva");
    expect(row.payer_document_masked).toBe("***.456.789-**");
    expect(row.needs_review).toBe(false);

    const serialized = JSON.stringify(row.last_provider_payload);
    expect(serialized).not.toContain("123.456.789-09");
    expect((row.last_provider_payload as { payer: { document: string } }).payer.document).toBe(
      "***.456.789-**",
    );
  });

  it("flags needs_review when PAID but the paid amount differs from the charged amount", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({ status: "PAID", paidAmountCents: 49999, paidAt: "2026-10-22T12:00:00Z" }),
    );

    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it("flags needs_review against OUR stored amount_cents, not Upper's own amountCents", async () => {
    // Upper reports PAID with its own amountCents/paidAmountCents matching
    // each other (50000/50000) — internally consistent on Upper's side —
    // but our stored charge says 60000. This must still be flagged.
    fake.admin.rows("payment_charges").push(chargeRow({ amount_cents: 60000 }));

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({
        status: "PAID",
        amountCents: 50000,
        paidAmountCents: 50000,
        paidAt: "2026-10-22T12:00:00Z",
      }),
    );

    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it("never clears needs_review once set, even when a later snapshot's amount matches", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ needs_review: true }));

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: "2026-10-22T12:00:00Z" }),
    );

    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it("writes provider_charge_id, emv, qr_code_image, payment_url and expires_at on create", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({
        id: "upstream-99",
        status: "ACTIVE",
        emv: "00020101...",
        qrCodeImage: "https://img.example/qr.png",
        paymentUrl: "https://pay.example/abc",
        expiresAt: "2026-10-22T13:00:00Z",
      }),
    );

    const row = fake.admin.rows("payment_charges")[0];
    expect(row.provider_charge_id).toBe("upstream-99");
    expect(row.emv).toBe("00020101...");
    expect(row.qr_code_image).toBe("https://img.example/qr.png");
    expect(row.payment_url).toBe("https://pay.example/abc");
    expect(row.expires_at).toBe("2026-10-22T13:00:00Z");
  });

  it("does not overwrite previously recorded Pix details with null on a later snapshot", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        provider_charge_id: "upstream-99",
        emv: "00020101...",
        qr_code_image: "https://img.example/qr.png",
        payment_url: "https://pay.example/abc",
        expires_at: "2026-10-22T13:00:00Z",
      }),
    );

    // Simulates a later GET (e.g. the reconciliation cron) whose response
    // omits the Pix fields — as a real provider might once a charge is
    // older/paid/expired.
    await recordChargeSnapshot(
      "charge-1",
      upperCharge({
        id: "",
        status: "PAID",
        paidAmountCents: 50000,
        paidAt: "2026-10-22T12:30:00Z",
        emv: null,
        qrCodeImage: null,
        paymentUrl: null,
        expiresAt: null,
      }),
    );

    const row = fake.admin.rows("payment_charges")[0];
    expect(row.provider_charge_id).toBe("upstream-99");
    expect(row.emv).toBe("00020101...");
    expect(row.qr_code_image).toBe("https://img.example/qr.png");
    expect(row.payment_url).toBe("https://pay.example/abc");
    expect(row.expires_at).toBe("2026-10-22T13:00:00Z");
  });

  it("marks the linked credit_topup_order lowercase for EXPIRED/CANCELLED/FAILED", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });

    await recordChargeSnapshot("charge-1", upperCharge({ status: "EXPIRED" }));

    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("expired");
  });

  it("does not touch the order for a still-ACTIVE charge", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });

    await recordChargeSnapshot("charge-1", upperCharge({ status: "ACTIVE" }));

    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("pending");
  });

  it.each([["EXPIRED"], ["CANCELLED"], ["FAILED"], ["ACTIVE"], ["PENDING"]] as const)(
    "a %s snapshot never overwrites a row already PAID, nor touches its order",
    async (status) => {
      fake.admin.rows("payment_charges").push(
        chargeRow({ status: "PAID", paid_amount_cents: 50000, paid_at: "2026-10-22T12:00:00Z" }),
      );
      fake.admin
        .rows("credit_topup_orders")
        .push({ id: "order-1", tenant_id: TENANT, status: "pending" });

      await recordChargeSnapshot("charge-1", upperCharge({ status }));

      const row = fake.admin.rows("payment_charges")[0];
      expect(row.status).toBe("PAID");
      expect(row.paid_at).toBe("2026-10-22T12:00:00Z");
      expect(row.paid_amount_cents).toBe(50000);
      expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("pending");
    },
  );

  it("an ACTIVE snapshot never reopens a charge already closed locally (EXPIRED)", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ status: "EXPIRED" }));

    await recordChargeSnapshot("charge-1", upperCharge({ status: "ACTIVE" }));

    expect(fake.admin.rows("payment_charges")[0].status).toBe("EXPIRED");
  });

  it.each([["EXPIRED"], ["FAILED"], ["CANCELLED"]] as const)(
    "a PAID snapshot moves a %s charge to PAID (money received must be credited)",
    async (status) => {
      fake.admin.rows("payment_charges").push(chargeRow({ status }));

      await recordChargeSnapshot(
        "charge-1",
        upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: "2026-10-22T12:30:00Z" }),
      );

      const row = fake.admin.rows("payment_charges")[0];
      expect(row.status).toBe("PAID");
      expect(row.paid_amount_cents).toBe(50000);
      expect(row.paid_at).toBe("2026-10-22T12:30:00Z");
    },
  );

  it("never writes paid_at/paid_amount_cents null over an existing value", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({ status: "PAID", paid_amount_cents: 50000, paid_at: "2026-10-22T12:00:00Z" }),
    );

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({ status: "PAID", paidAmountCents: null, paidAt: null }),
    );

    const row = fake.admin.rows("payment_charges")[0];
    expect(row.paid_at).toBe("2026-10-22T12:00:00Z");
    expect(row.paid_amount_cents).toBe(50000);
  });

  it("only moves the order to a terminal status while it is still 'pending'", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ status: "ACTIVE" }));
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "paid" });

    await recordChargeSnapshot("charge-1", upperCharge({ status: "EXPIRED" }));

    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("paid");
  });

  it("masks a payer document nested anywhere in last_provider_payload", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());

    await recordChargeSnapshot(
      "charge-1",
      upperCharge({
        status: "ACTIVE",
        raw: {
          status: "ACTIVE",
          payments: [{ payer: { Document: "123.456.789-09" } }],
          meta: { nested: { document: 12345 } },
        },
      }),
    );

    const payload = fake.admin.rows("payment_charges")[0].last_provider_payload as {
      payments: Array<{ payer: { Document: string } }>;
      meta: { nested: { document: unknown } };
    };
    expect(JSON.stringify(payload)).not.toContain("123.456.789-09");
    expect(payload.payments[0].payer.Document).toBe("***.456.789-**");
    expect(payload.meta.nested.document).toBeNull();
  });
});

describe("confirmChargeFromUpper", () => {
  beforeEach(() => {
    fake.admin.onRpc("billing_credit_paid_charge", (args) => ({
      data: { ok: true, charge_id: args._charge_id },
      error: null,
    }));
  });

  it("credits a PAID charge whose paid amount matches", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    getUpperCharge.mockResolvedValue(
      upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
    );

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "credited" });
    expect(fake.admin.rows("payment_charges")[0].status).toBe("PAID");
  });

  describe("tenant-status cache after an invoice settle", () => {
    beforeEach(() => {
      __resetDemoTenantCacheForTests();
      vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
      // Enforcement only counts with invoices on (fails closed otherwise).
      vi.stubEnv("BILLING_INVOICES_ENABLED", "true");
      fake.admin.rows("tenants").push({
        id: TENANT,
        status: "active",
        is_demo: false,
        tenant_billing: { access_state: "locked_unpaid" },
      });
    });
    afterEach(() => vi.unstubAllEnvs());

    async function primeLockedCacheThenSettle(kind: string) {
      // The guard caches the locked state for 5 s.
      await expect(assertTenantNotDemoForSend(TENANT)).rejects.toMatchObject({
        code: "BILLING_LOCKED",
      });
      // The SQL settle recomputes access_state (simulated here).
      fake.admin.rows("tenants")[0].tenant_billing = { access_state: "ok" };
      fake.admin.rows("payment_charges").push(
        chargeRow({ kind, ref_id: "inv-1", external_id: "bl-inv-inv-1-1" }),
      );
      getUpperCharge.mockResolvedValue(
        upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
      );
      expect(await confirmChargeFromUpper("bl-inv-inv-1-1")).toEqual({ outcome: "credited" });
    }

    it("a credited invoice drops the house from the cache: it unlocks at once", async () => {
      await primeLockedCacheThenSettle("invoice");
      await expect(assertTenantNotDemoForSend(TENANT)).resolves.toBeUndefined();
    });

    it("never waits for the 'paid' e-mail: confirmChargeFromUpper resolves even while it is still pending", async () => {
      // A sendBillingEmail that never resolves: if confirmChargeFromUpper
      // awaited it, this test would time out instead of resolving below.
      sendBillingEmail.mockReturnValue(
        new Promise(() => {
          /* intentionally never settles */
        }),
      );
      fake.admin.rows("payment_charges").push(
        chargeRow({ kind: "invoice", ref_id: "inv-1", external_id: "bl-inv-inv-1-1" }),
      );
      getUpperCharge.mockResolvedValue(
        upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
      );

      const result = await confirmChargeFromUpper("bl-inv-inv-1-1");

      expect(result).toEqual({ outcome: "credited" });
      expect(sendBillingEmail).toHaveBeenCalledWith("inv-1", "paid");
    });

    it("a credit top-up leaves the cache alone (still the cached state)", async () => {
      await primeLockedCacheThenSettle("credit_topup");
      await expect(assertTenantNotDemoForSend(TENANT)).rejects.toMatchObject({
        code: "BILLING_LOCKED",
      });
    });
  });

  it("marks needs_review and does not call the RPC when the paid amount differs", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    getUpperCharge.mockResolvedValue(
      upperCharge({ status: "PAID", paidAmountCents: 49999, paidAt: new Date().toISOString() }),
    );
    const rpcSpy = vi.fn((args: Record<string, unknown>) => ({
      data: { ok: true, charge_id: args._charge_id },
      error: null,
    }));
    fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "needs_review" });
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it("needs_review when Upper's amount matches its own paid amount but differs from our stored amount_cents, and does not credit", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ amount_cents: 60000 }));
    getUpperCharge.mockResolvedValue(
      upperCharge({
        status: "PAID",
        amountCents: 50000,
        paidAmountCents: 50000,
        paidAt: new Date().toISOString(),
      }),
    );
    const rpcSpy = vi.fn(() => ({ data: { ok: true }, error: null }));
    fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "needs_review" });
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it("stays needs_review and uncredited when the flag was already set, even with a matching payment", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ needs_review: true }));
    getUpperCharge.mockResolvedValue(
      upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
    );
    const rpcSpy = vi.fn(() => ({ data: { ok: true }, error: null }));
    fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "needs_review" });
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")[0].needs_review).toBe(true);
  });

  it.each(["invoice_not_open", "invoice_not_found", "amount_mismatch"])(
    "an invoice charge the RPC refuses with %s is needs_review (the RPC flags it)",
    async (reason) => {
      fake.admin
        .rows("payment_charges")
        .push(
          chargeRow({ kind: "invoice", ref_id: "invoice-1", external_id: "bl-inv-invoice-1-1" }),
        );
      getUpperCharge.mockResolvedValue(
        upperCharge({
          externalId: "bl-inv-invoice-1-1",
          status: "PAID",
          paidAmountCents: 50000,
          paidAt: new Date().toISOString(),
        }),
      );
      const rpcSpy = vi.fn(() => ({ data: { ok: false, reason }, error: null }));
      fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

      const result = await confirmChargeFromUpper("bl-inv-invoice-1-1");
      expect(rpcSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ outcome: "needs_review" });
    },
  );

  it("returns not_paid for an ACTIVE charge, without calling the RPC", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    getUpperCharge.mockResolvedValue(upperCharge({ status: "ACTIVE" }));
    const rpcSpy = vi.fn(() => ({ data: { ok: true }, error: null }));
    fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "not_paid" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("returns unknown_charge for an externalId with no matching row, never calling Upper", async () => {
    const result = await confirmChargeFromUpper("bl-top-does-not-exist");
    expect(result).toEqual({ outcome: "unknown_charge" });
    expect(getUpperCharge).not.toHaveBeenCalled();
  });

  it("marks the linked order expired for an EXPIRED charge and returns not_paid", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });
    getUpperCharge.mockResolvedValue(upperCharge({ status: "EXPIRED" }));

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "not_paid" });
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("expired");
  });

  it("credits a late PAID (webhook/cron) on a charge already EXPIRED locally", async () => {
    fake.admin.rows("payment_charges").push(chargeRow({ status: "EXPIRED" }));
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "expired" });
    const rpc = installCreditRpc();
    getUpperCharge.mockResolvedValue(
      upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
    );

    const result = await confirmChargeFromUpper("bl-top-order-1");

    expect(result).toEqual({ outcome: "credited" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const row = fake.admin.rows("payment_charges")[0];
    expect(row.status).toBe("PAID");
    expect(row.credited_at).toBeTruthy();
  });

  it("returns already_credited when the RPC reports idempotent:true", async () => {
    fake.admin.rows("payment_charges").push(chargeRow());
    getUpperCharge.mockResolvedValue(
      upperCharge({ status: "PAID", paidAmountCents: 50000, paidAt: new Date().toISOString() }),
    );
    fake.admin.onRpc("billing_credit_paid_charge", () => ({
      data: { ok: true, idempotent: true },
      error: null,
    }));

    const result = await confirmChargeFromUpper("bl-top-order-1");
    expect(result).toEqual({ outcome: "already_credited" });
  });
});

describe("reconcilePendingCharges", () => {
  const NOW = new Date("2026-10-22T12:10:00Z");
  const OLD_ENOUGH = "2026-10-22T12:00:00Z"; // 10 min before NOW, past the 2 min cutoff

  beforeEach(() => {
    fake.admin.onRpc("billing_credit_paid_charge", () => ({ data: { ok: true }, error: null }));
  });

  it("checks pending/active charges older than 2 minutes, crediting the one Upper reports PAID", async () => {
    fake.admin
      .rows("payment_charges")
      .push(
        chargeRow({ id: "c1", external_id: "bl-top-c1", status: "PENDING", created_at: OLD_ENOUGH }),
        chargeRow({ id: "c2", external_id: "bl-top-c2", status: "ACTIVE", created_at: OLD_ENOUGH }),
        chargeRow({ id: "c3", external_id: "bl-top-c3", status: "ACTIVE", created_at: OLD_ENOUGH }),
      );
    getUpperCharge.mockImplementation(async (externalId: string) =>
      upperCharge({
        externalId,
        status: externalId === "bl-top-c2" ? "PAID" : "ACTIVE",
        paidAmountCents: externalId === "bl-top-c2" ? 50000 : null,
        paidAt: externalId === "bl-top-c2" ? NOW.toISOString() : null,
      }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result).toEqual({ checked: 3, credited: 1, expired: 0, errors: 0 });
  });

  it("counts a network error on one charge and keeps checking the others", async () => {
    fake.admin
      .rows("payment_charges")
      .push(
        chargeRow({ id: "c1", external_id: "bl-top-c1", status: "PENDING", created_at: OLD_ENOUGH }),
        chargeRow({ id: "c2", external_id: "bl-top-c2", status: "ACTIVE", created_at: OLD_ENOUGH }),
        chargeRow({ id: "c3", external_id: "bl-top-c3", status: "ACTIVE", created_at: OLD_ENOUGH }),
      );
    getUpperCharge.mockImplementation(async (externalId: string) => {
      if (externalId === "bl-top-c2") {
        throw new UpperError("Falha de rede ao chamar a Upper.", {
          status: 0,
          code: "NETWORK_ERROR",
          retryable: true,
        });
      }
      return upperCharge({ externalId, status: "ACTIVE" });
    });

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result).toEqual({ checked: 3, credited: 0, expired: 0, errors: 1 });
  });

  it("ignores a charge created less than 2 minutes ago", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PENDING",
        created_at: NOW.toISOString(),
      }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result).toEqual({ checked: 0, credited: 0, expired: 0, errors: 0 });
    expect(getUpperCharge).not.toHaveBeenCalled();
  });

  it("credits a locally PAID charge with no credited_at, without calling Upper", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PAID",
        credited_at: null,
        needs_review: false,
        created_at: OLD_ENOUGH,
      }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result.credited).toBe(1);
    expect(getUpperCharge).not.toHaveBeenCalled();
  });

  it("does not directly credit a locally PAID charge flagged needs_review", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PAID",
        credited_at: null,
        needs_review: true,
        created_at: OLD_ENOUGH,
      }),
    );
    const rpcSpy = vi.fn(() => ({ data: { ok: true }, error: null }));
    fake.admin.onRpc("billing_credit_paid_charge", rpcSpy);

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result.credited).toBe(0);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("respects the limit option for the pending/active batch", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({ id: "c1", external_id: "bl-top-c1", status: "ACTIVE", created_at: OLD_ENOUGH }),
      chargeRow({ id: "c2", external_id: "bl-top-c2", status: "ACTIVE", created_at: OLD_ENOUGH }),
      chargeRow({ id: "c3", external_id: "bl-top-c3", status: "ACTIVE", created_at: OLD_ENOUGH }),
    );
    getUpperCharge.mockImplementation(async (externalId: string) =>
      upperCharge({ externalId, status: "ACTIVE" }),
    );

    const result = await reconcilePendingCharges({ now: NOW, limit: 2 });
    expect(result.checked).toBe(2);
  });

  it("marks a charge EXPIRED locally when Upper still reports ACTIVE more than 10 minutes past our expires_at", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "ACTIVE",
        created_at: OLD_ENOUGH,
        expires_at: "2026-10-22T11:59:00Z", // 11 min before NOW
      }),
    );
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });
    getUpperCharge.mockResolvedValue(
      upperCharge({ externalId: "bl-top-c1", status: "ACTIVE", expiresAt: "2026-10-22T11:59:00Z" }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result.expired).toBe(1);
    expect(fake.admin.rows("payment_charges")[0].status).toBe("EXPIRED");
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("expired");
  });

  it("marks a charge FAILED with last_error 'upper_not_found' when Upper 404s and the charge is older than 15 minutes", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PENDING",
        created_at: "2026-10-22T11:50:00Z", // 20 min before NOW
      }),
    );
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });
    getUpperCharge.mockRejectedValue(
      new UpperError("Cobrança não encontrada.", { status: 404, code: null, retryable: false }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result).toEqual({ checked: 1, credited: 0, expired: 0, errors: 1 });
    const row = fake.admin.rows("payment_charges")[0];
    expect(row.status).toBe("FAILED");
    expect(row.last_error).toBe("upper_not_found");
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("failed");
  });

  it("only counts a 404 as an error (no status change) when the charge is younger than 15 minutes", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PENDING",
        created_at: "2026-10-22T12:05:00Z", // 5 min before NOW, past the 2 min cutoff
      }),
    );
    getUpperCharge.mockRejectedValue(
      new UpperError("Cobrança não encontrada.", { status: 404, code: null, retryable: false }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result).toEqual({ checked: 1, credited: 0, expired: 0, errors: 1 });
    expect(fake.admin.rows("payment_charges")[0].status).toBe("PENDING");
  });

  it("never marks a credited charge FAILED, even on a 404 past the 15-minute mark", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "ACTIVE",
        credited_at: NOW.toISOString(),
        created_at: "2026-10-22T11:50:00Z",
      }),
    );
    getUpperCharge.mockRejectedValue(
      new UpperError("Cobrança não encontrada.", { status: 404, code: null, retryable: false }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result.errors).toBe(1);
    expect(fake.admin.rows("payment_charges")[0].status).not.toBe("FAILED");
  });

  it("checks an unchecked charge (updated_at null) before one already checked this cycle, oldest-updated first", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "already-checked",
        external_id: "bl-top-already-checked",
        status: "ACTIVE",
        created_at: OLD_ENOUGH,
        updated_at: "2026-10-22T12:05:00Z",
      }),
      chargeRow({
        id: "never-checked",
        external_id: "bl-top-never-checked",
        status: "ACTIVE",
        created_at: OLD_ENOUGH,
        // updated_at intentionally absent: never touched by the sweep yet.
      }),
    );
    getUpperCharge.mockImplementation(async (externalId: string) =>
      upperCharge({ externalId, status: "ACTIVE" }),
    );

    await reconcilePendingCharges({ now: NOW, limit: 1 });
    expect(getUpperCharge).toHaveBeenCalledTimes(1);
    expect(getUpperCharge).toHaveBeenCalledWith("bl-top-never-checked");
  });

  it("touches updated_at on every charge checked, success or error", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({ id: "c1", external_id: "bl-top-c1", status: "ACTIVE", created_at: OLD_ENOUGH }),
      chargeRow({ id: "c2", external_id: "bl-top-c2", status: "ACTIVE", created_at: OLD_ENOUGH }),
    );
    getUpperCharge.mockImplementation(async (externalId: string) => {
      if (externalId === "bl-top-c2") {
        throw new UpperError("Falha de rede ao chamar a Upper.", {
          status: 0,
          code: "NETWORK_ERROR",
          retryable: true,
        });
      }
      return upperCharge({ externalId, status: "ACTIVE" });
    });

    await reconcilePendingCharges({ now: NOW });
    expect(fake.admin.rows("payment_charges")[0].updated_at).toBe(NOW.toISOString());
    expect(fake.admin.rows("payment_charges")[1].updated_at).toBe(NOW.toISOString());
  });

  it("never marks an already-credited charge EXPIRED even if its expires_at is long past", async () => {
    // Defensive case: a charge already carrying credited_at (should not
    // normally coexist with status ACTIVE, but the guard must hold anyway).
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "ACTIVE",
        credited_at: NOW.toISOString(),
        created_at: OLD_ENOUGH,
        expires_at: "2026-10-22T11:59:00Z",
      }),
    );
    getUpperCharge.mockResolvedValue(
      upperCharge({ externalId: "bl-top-c1", status: "ACTIVE", expiresAt: "2026-10-22T11:59:00Z" }),
    );

    const result = await reconcilePendingCharges({ now: NOW });
    expect(result.expired).toBe(0);
    expect(fake.admin.rows("payment_charges")[0].status).not.toBe("EXPIRED");
  });

  it("an expiry write racing a PAID snapshot leaves the charge PAID and the order untouched", async () => {
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "ACTIVE",
        created_at: OLD_ENOUGH,
        expires_at: "2026-10-22T11:59:00Z",
      }),
    );
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });
    getUpperCharge.mockResolvedValue(
      upperCharge({ externalId: "bl-top-c1", status: "ACTIVE", expiresAt: "2026-10-22T11:59:00Z" }),
    );
    racePaidBeforeUpdate("c1", "EXPIRED");

    const result = await reconcilePendingCharges({ now: NOW });

    expect(result.expired).toBe(0);
    expect(fake.admin.rows("payment_charges")[0].status).toBe("PAID");
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("pending");
  });

  it("a not-found FAILED write racing a PAID snapshot leaves the charge PAID and the order untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.admin.rows("payment_charges").push(
      chargeRow({
        id: "c1",
        external_id: "bl-top-c1",
        status: "PENDING",
        created_at: "2026-10-22T11:50:00Z",
      }),
    );
    fake.admin
      .rows("credit_topup_orders")
      .push({ id: "order-1", tenant_id: TENANT, status: "pending" });
    getUpperCharge.mockRejectedValue(
      new UpperError("Cobrança não encontrada.", { status: 404, code: null, retryable: false }),
    );
    racePaidBeforeUpdate("c1", "FAILED");

    await reconcilePendingCharges({ now: NOW });

    const row = fake.admin.rows("payment_charges")[0];
    expect(row.status).toBe("PAID");
    expect(row.last_error).toBeUndefined();
    expect(fake.admin.rows("credit_topup_orders")[0].status).toBe("pending");
  });

  describe("terminal-uncredited sweep", () => {
    it("credits a FAILED charge that Upper now reports PAID", async () => {
      fake.admin.rows("payment_charges").push(
        chargeRow({
          id: "c1",
          external_id: "bl-top-c1",
          status: "FAILED",
          created_at: OLD_ENOUGH,
          credited_at: null,
        }),
      );
      fake.admin
        .rows("credit_topup_orders")
        .push({ id: "order-1", tenant_id: TENANT, status: "failed" });
      const rpc = installCreditRpc();
      getUpperCharge.mockResolvedValue(
        upperCharge({
          externalId: "bl-top-c1",
          status: "PAID",
          paidAmountCents: 50000,
          paidAt: NOW.toISOString(),
        }),
      );

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result).toEqual({ checked: 1, credited: 1, expired: 0, errors: 0 });
      expect(getUpperCharge).toHaveBeenCalledWith("bl-top-c1");
      expect(rpc).toHaveBeenCalledTimes(1);
      const row = fake.admin.rows("payment_charges")[0];
      expect(row.status).toBe("PAID");
      expect(row.credited_at).toBeTruthy();
      expect(row.updated_at).toBe(NOW.toISOString());
    });

    it("re-checks EXPIRED and CANCELLED too, leaving them closed while Upper still says not paid", async () => {
      fake.admin
        .rows("payment_charges")
        .push(
          chargeRow({ id: "c1", external_id: "bl-top-c1", status: "EXPIRED", created_at: OLD_ENOUGH }),
          chargeRow({ id: "c2", external_id: "bl-top-c2", status: "CANCELLED", created_at: OLD_ENOUGH }),
        );
      getUpperCharge.mockImplementation(async (externalId: string) =>
        upperCharge({ externalId, status: "ACTIVE" }),
      );

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result).toEqual({ checked: 2, credited: 0, expired: 0, errors: 0 });
      expect(fake.admin.rows("payment_charges").map((r) => r.status)).toEqual([
        "EXPIRED",
        "CANCELLED",
      ]);
    });

    it("skips charges older than 48 h, flagged needs_review or already credited", async () => {
      fake.admin.rows("payment_charges").push(
        chargeRow({
          id: "old",
          external_id: "bl-top-old",
          status: "EXPIRED",
          created_at: "2026-10-20T12:00:00Z",
        }),
        chargeRow({
          id: "review",
          external_id: "bl-top-review",
          status: "FAILED",
          needs_review: true,
          created_at: OLD_ENOUGH,
        }),
        chargeRow({
          id: "credited",
          external_id: "bl-top-credited",
          status: "EXPIRED",
          credited_at: OLD_ENOUGH,
          created_at: OLD_ENOUGH,
        }),
      );

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result.checked).toBe(0);
      expect(getUpperCharge).not.toHaveBeenCalled();
    });

    it("checks at most 10 per run, oldest-checked first", async () => {
      for (let i = 0; i < 12; i++) {
        fake.admin.rows("payment_charges").push(
          chargeRow({
            id: `t${i}`,
            external_id: `bl-top-t${i}`,
            status: "EXPIRED",
            created_at: OLD_ENOUGH,
            // t10/t11 never checked (updated_at null) -> must come first.
            updated_at: i >= 10 ? undefined : `2026-10-22T12:0${i}:00Z`,
          }),
        );
      }
      getUpperCharge.mockImplementation(async (externalId: string) =>
        upperCharge({ externalId, status: "EXPIRED" }),
      );

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result.checked).toBe(10);
      expect(getUpperCharge).toHaveBeenCalledWith("bl-top-t10");
      expect(getUpperCharge).toHaveBeenCalledWith("bl-top-t11");
      expect(getUpperCharge).not.toHaveBeenCalledWith("bl-top-t9");
      expect(getUpperCharge).not.toHaveBeenCalledWith("bl-top-t8");
    });

    it("does not count a 404 (Upper never created it) as an error, but counts other failures", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      fake.admin
        .rows("payment_charges")
        .push(
          chargeRow({ id: "c1", external_id: "bl-top-c1", status: "FAILED", created_at: OLD_ENOUGH }),
          chargeRow({ id: "c2", external_id: "bl-top-c2", status: "FAILED", created_at: OLD_ENOUGH }),
        );
      getUpperCharge.mockImplementation(async (externalId: string) => {
        if (externalId === "bl-top-c1") {
          throw new UpperError("Cobrança não encontrada.", {
            status: 404,
            code: null,
            retryable: false,
          });
        }
        throw new UpperError("Falha de rede ao chamar a Upper.", {
          status: 0,
          code: "NETWORK_ERROR",
          retryable: true,
        });
      });

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result).toEqual({ checked: 2, credited: 0, expired: 0, errors: 1 });
      expect(fake.admin.rows("payment_charges").every((r) => r.status === "FAILED")).toBe(true);
    });

    it("does not re-ask Upper about a charge the PENDING/ACTIVE batch just closed in the same run", async () => {
      fake.admin.rows("payment_charges").push(
        chargeRow({
          id: "c1",
          external_id: "bl-top-c1",
          status: "ACTIVE",
          created_at: OLD_ENOUGH,
          expires_at: "2026-10-22T11:59:00Z",
        }),
      );
      getUpperCharge.mockResolvedValue(
        upperCharge({ externalId: "bl-top-c1", status: "ACTIVE", expiresAt: "2026-10-22T11:59:00Z" }),
      );

      const result = await reconcilePendingCharges({ now: NOW });

      expect(result).toEqual({ checked: 1, credited: 0, expired: 1, errors: 0 });
      expect(getUpperCharge).toHaveBeenCalledTimes(1);
    });
  });
});
