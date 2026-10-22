import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { getUpperCharge } = vi.hoisted(() => ({ getUpperCharge: vi.fn() }));
vi.mock("./upper-pix.server", () => ({ getUpperCharge }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { confirmChargeFromUpper, recordChargeSnapshot } from "./payment-charges.server";
import type { UpperCharge } from "./upper-pix.server";

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

beforeEach(() => {
  fake.admin.reset();
  getUpperCharge.mockReset();
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
