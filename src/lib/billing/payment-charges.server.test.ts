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

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  confirmChargeFromUpper,
  reconcilePendingCharges,
  recordChargeSnapshot,
} from "./payment-charges.server";
import { UpperError, type UpperCharge } from "./upper-pix.server";

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
});
