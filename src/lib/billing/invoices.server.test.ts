import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb({ unique: { payment_charges: [["external_id"]] } });
  return { supabaseAdmin: fake.admin.client };
});

const { createUpperCharge, cancelUpperCharge } = vi.hoisted(() => ({
  createUpperCharge: vi.fn(),
  cancelUpperCharge: vi.fn(),
}));
vi.mock("./upper-pix.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upper-pix.server")>();
  return { ...actual, createUpperCharge, cancelUpperCharge };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  cancelOpenInvoiceCharges,
  createInvoicePayment,
  runBillingCycle,
} from "./invoices.server";
import { UpperError, type UpperCharge } from "./upper-pix.server";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ACTOR = "00000000-0000-4000-8000-0000000000bb";

function upperChargeResult(overrides: Partial<UpperCharge> = {}): UpperCharge {
  return {
    id: "upstream-1",
    externalId: overrides.externalId ?? "bl-inv-x",
    status: "ACTIVE",
    amountCents: 400000,
    emv: "00020101...",
    qrCodeImage: "https://img.example/qr.png",
    paymentUrl: "https://pay.example/x",
    expiresAt: "2026-10-25T23:59:59-03:00",
    paidAt: null,
    paidAmountCents: null,
    payer: null,
    raw: { status: "ACTIVE" },
    ...overrides,
  };
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "invoice-1",
    tenant_id: TENANT,
    status: "open",
    amount_cents: 400000,
    due_date: "2026-10-25",
    cycle_due_date: "2026-10-25",
    period_start: "2026-10-25",
    period_end: "2026-11-24",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.BILLING_INVOICES_ENABLED = "true";
  process.env.UPPER_API_KEY = "test-upper-key";

  fake.admin.reset();
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Sorte Alta", plano: "padrao" });

  createUpperCharge.mockReset();
  createUpperCharge.mockResolvedValue(upperChargeResult());
  cancelUpperCharge.mockReset();
  cancelUpperCharge.mockResolvedValue(upperChargeResult({ status: "CANCELLED" }));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BILLING_INVOICES_ENABLED;
  delete process.env.UPPER_API_KEY;
});

describe("runBillingCycle", () => {
  function seedTenantBilling(overrides: Record<string, unknown> = {}) {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      access_state: "due_soon",
      next_due_date: "2026-10-25",
      ...overrides,
    });
  }

  it("does nothing to invoices with the flag off, but still refreshes access state", async () => {
    process.env.BILLING_INVOICES_ENABLED = "false";
    seedTenantBilling();
    const refreshRpc = vi.fn((_args: Record<string, unknown>) => ({ data: "due_soon", error: null }));
    fake.admin.onRpc("billing_refresh_access_state", refreshRpc);
    const generateRpc = vi.fn(() => ({ data: ["new-invoice-1"], error: null }));
    fake.admin.onRpc("billing_generate_due_invoices", generateRpc);

    const sendEmails = vi.fn().mockResolvedValue(undefined);
    const result = await runBillingCycle({ sendEmails });

    expect(generateRpc).not.toHaveBeenCalled();
    expect(refreshRpc).toHaveBeenCalledTimes(1);
    expect(refreshRpc.mock.calls[0][0]).toEqual({ _tenant: TENANT });
    expect(sendEmails).not.toHaveBeenCalled();
    expect(result.generated).toBe(0);
    expect(result.refreshed).toBe(1);
    expect(result.issued).toBe(0);
  });

  it("generates due invoices and refreshes state when the flag is on, calling sendEmails with issued ids", async () => {
    seedTenantBilling();
    fake.admin.onRpc("billing_refresh_access_state", () => ({ data: "due_soon", error: null }));
    fake.admin.onRpc("billing_generate_due_invoices", () => ({
      data: ["new-invoice-1", "new-invoice-2"],
      error: null,
    }));

    const sendEmails = vi.fn().mockResolvedValue(undefined);
    const result = await runBillingCycle({ sendEmails });

    expect(result.generated).toBe(2);
    expect(result.refreshed).toBe(1);
    expect(result.issued).toBe(2);
    expect(sendEmails).toHaveBeenCalledWith({ issuedInvoiceIds: ["new-invoice-1", "new-invoice-2"] });
  });

  it("does not call sendEmails and defaults to a no-op when none is injected", async () => {
    seedTenantBilling();
    fake.admin.onRpc("billing_refresh_access_state", () => ({ data: "due_soon", error: null }));
    fake.admin.onRpc("billing_generate_due_invoices", () => ({ data: [], error: null }));

    await expect(runBillingCycle()).resolves.toMatchObject({ generated: 0, refreshed: 1 });
  });

  it("never refreshes an already-exempt house, and one house's failure does not stop the others", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000000cc";
    seedTenantBilling();
    fake.admin.rows("tenant_billing").push({
      tenant_id: OTHER,
      access_state: "ok",
      next_due_date: "2026-10-25",
    });
    fake.admin.rows("tenant_billing").push({
      tenant_id: "00000000-0000-4000-8000-0000000000dd",
      access_state: "exempt",
      next_due_date: null,
    });
    fake.admin.onRpc("billing_generate_due_invoices", () => ({ data: [], error: null }));
    const refreshRpc = vi.fn((args: Record<string, unknown>) => {
      if (args._tenant === TENANT) return { data: null, error: { message: "boom" } };
      return { data: "ok", error: null };
    });
    fake.admin.onRpc("billing_refresh_access_state", refreshRpc);

    const result = await runBillingCycle();

    expect(refreshRpc).toHaveBeenCalledTimes(2);
    expect(result.refreshed).toBe(1);
  });

  it("still refreshes every house and counts the error when billing_generate_due_invoices itself fails", async () => {
    seedTenantBilling();
    fake.admin.onRpc("billing_generate_due_invoices", () => ({
      data: null,
      error: { message: "statement timeout" },
    }));
    const refreshRpc = vi.fn(() => ({ data: "due_soon", error: null }));
    fake.admin.onRpc("billing_refresh_access_state", refreshRpc);
    const sendEmails = vi.fn().mockResolvedValue(undefined);

    const result = await runBillingCycle({ sendEmails });

    expect(refreshRpc).toHaveBeenCalledTimes(1);
    expect(result.refreshed).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    // No invoices were issued, so sendEmails is still called (flag is on)
    // but with an empty list — never with stale/partial ids.
    expect(sendEmails).toHaveBeenCalledWith({ issuedInvoiceIds: [] });
  });
});

describe("createInvoicePayment", () => {
  it("reuses a still-valid (>5min) ACTIVE charge for the same amount", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "ACTIVE",
      amount_cents: 400000,
      emv: "existing-emv",
      qr_code_image: "existing-qr",
      payment_url: "existing-url",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const result = await createInvoicePayment("invoice-1", ACTOR);

    expect(result.chargeId).toBe("charge-1");
    expect(result.emv).toBe("existing-emv");
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")).toHaveLength(1);
  });

  it("creates bl-inv-<id>-2 once the previous charge is actually EXPIRED (no longer open)", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "EXPIRED",
      amount_cents: 400000,
    });
    createUpperCharge.mockResolvedValue(upperChargeResult({ externalId: "bl-inv-invoice-1-2" }));

    const result = await createInvoicePayment("invoice-1", ACTOR);

    expect(result.chargeId).not.toBe("charge-1");
    const rows = fake.admin.rows("payment_charges");
    expect(rows).toHaveLength(2);
    const newCharge = rows.find((r) => r.id !== "charge-1")!;
    expect(newCharge.external_id).toBe("bl-inv-invoice-1-2");
    expect(createUpperCharge).toHaveBeenCalledTimes(1);
    expect(createUpperCharge.mock.calls[0][0].externalId).toBe("bl-inv-invoice-1-2");
  });

  it("an open ACTIVE charge of the same amount but <=5min left blocks a new one (generic message)", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "ACTIVE",
      amount_cents: 400000,
      expires_at: new Date(Date.now() + 60_000).toISOString(), // less than 5 min left
    });

    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Não foi possível gerar o Pix agora. Tente de novo em instantes.",
    );
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")).toHaveLength(1);
  });

  it("an open PENDING charge of the same amount throws 'Gerando o Pix...' without creating a second one", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "PENDING",
      amount_cents: 400000,
    });

    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Gerando o Pix, tente de novo em instantes.",
    );
    expect(createUpperCharge).not.toHaveBeenCalled();
    expect(fake.admin.rows("payment_charges")).toHaveLength(1);
  });

  it("cancels an open charge of a stale (different) amount before creating a new one", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ amount_cents: 400000 }));
    fake.admin.rows("payment_charges").push({
      id: "charge-stale",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "ACTIVE",
      amount_cents: 350000, // the invoice was repriced after this charge was created
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    createUpperCharge.mockResolvedValue(upperChargeResult({ externalId: "bl-inv-invoice-1-2" }));

    const result = await createInvoicePayment("invoice-1", ACTOR);

    expect(cancelUpperCharge).toHaveBeenCalledTimes(1);
    expect(cancelUpperCharge).toHaveBeenCalledWith("bl-inv-invoice-1-1");
    const stale = fake.admin.rows("payment_charges").find((r) => r.id === "charge-stale")!;
    expect(stale.status).toBe("CANCELLED");
    expect(result.chargeId).not.toBe("charge-stale");
    expect(result.amountCents).toBe(400000);
    const created = fake.admin.rows("payment_charges").find((r) => r.id === result.chargeId)!;
    expect(created.amount_cents).toBe(400000);
  });

  describe("concurrent second call racing the payment_charges_one_open_per_invoice index", () => {
    // Simulates two concurrent createInvoicePayment calls both finding no
    // open charge, then both trying to insert one: the second (and, since
    // our own retry also collides on the still-open winner, every
    // subsequent) insert hits the DB's partial unique index (ref_id,
    // kind='invoice', status in PENDING/ACTIVE) and must never create a
    // second open charge. `injected` is hoisted so it's shared across every
    // `.from("payment_charges")` call this test makes (a fresh builder is
    // created per call) — the winner's row is pushed exactly once, on the
    // first insert attempt, and keeps rejecting every later attempt too.
    function simulateRaceOnInsert(winnerCharge: Record<string, unknown>) {
      type Builder = Record<string, (...args: unknown[]) => unknown>;
      const client = fake.admin.client as unknown as { from: (table: string) => Builder };
      const originalFrom = client.from;
      let injected = false;
      vi.spyOn(client, "from").mockImplementation((table: string) => {
        const builder = originalFrom(table);
        if (table !== "payment_charges") return builder;
        const originalInsert = builder.insert;
        builder.insert = (...args: unknown[]) => {
          const value = args[0] as Record<string, unknown>;
          if (value.kind !== "invoice") return originalInsert(...args);
          if (!injected) {
            injected = true;
            fake.admin.rows("payment_charges").push({
              created_at: new Date().toISOString(),
              ...winnerCharge,
            });
          }
          const hasOpenCharge = fake.admin
            .rows("payment_charges")
            .some(
              (row) =>
                row.kind === "invoice" &&
                row.ref_id === value.ref_id &&
                ["PENDING", "ACTIVE"].includes(row.status as string),
            );
          if (hasOpenCharge) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: {
                    message:
                      'duplicate key value violates unique constraint "payment_charges_one_open_per_invoice"',
                    code: "23505",
                  },
                }),
              }),
            };
          }
          return originalInsert(...args);
        };
        return builder;
      });
    }

    it("returns the concurrent winner's ACTIVE charge instead of creating a second one", async () => {
      fake.admin.rows("billing_invoices").push(invoiceRow());
      simulateRaceOnInsert({
        id: "charge-winner",
        tenant_id: TENANT,
        kind: "invoice",
        ref_id: "invoice-1",
        external_id: "bl-inv-invoice-1-1",
        status: "ACTIVE",
        amount_cents: 400000,
        emv: "winner-emv",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });

      const result = await createInvoicePayment("invoice-1", ACTOR);

      expect(result.chargeId).toBe("charge-winner");
      expect(result.emv).toBe("winner-emv");
      expect(createUpperCharge).not.toHaveBeenCalled();
      expect(fake.admin.rows("payment_charges")).toHaveLength(1);
    });

    it("throws 'Gerando o Pix...' when the concurrent winner's charge is still PENDING", async () => {
      fake.admin.rows("billing_invoices").push(invoiceRow());
      simulateRaceOnInsert({
        id: "charge-winner",
        tenant_id: TENANT,
        kind: "invoice",
        ref_id: "invoice-1",
        external_id: "bl-inv-invoice-1-1",
        status: "PENDING",
        amount_cents: 400000,
      });

      await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
        "Gerando o Pix, tente de novo em instantes.",
      );
      expect(createUpperCharge).not.toHaveBeenCalled();
      expect(fake.admin.rows("payment_charges")).toHaveLength(1);
    });
  });

  it("computes expiresIn between 3600 and 604800, clamped at the end of due_date+3 Brasília", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ due_date: "2026-10-25" }));

    await createInvoicePayment("invoice-1", ACTOR);

    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.expiresIn).toBeGreaterThanOrEqual(3600);
    expect(callArgs.expiresIn).toBeLessThanOrEqual(604800);
  });

  it("falls back to 3600 when due_date+3 is already in the past", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ due_date: "2000-01-01" }));

    await createInvoicePayment("invoice-1", ACTOR);

    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.expiresIn).toBe(3600);
  });

  it("uses a description <=140 chars in the 'Casa - Mensalidade BetLeads MM/AAAA' format", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ cycle_due_date: "2026-10-25" }));

    await createInvoicePayment("invoice-1", ACTOR);

    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.description.length).toBeLessThanOrEqual(140);
    expect(callArgs.description).toBe("Sorte Alta - Mensalidade BetLeads 10/2026");
  });

  it("truncates a very long house name but keeps the fixed suffix intact", async () => {
    fake.admin.rows("tenants")[0].nome = "A".repeat(200);
    fake.admin.rows("billing_invoices").push(invoiceRow({ cycle_due_date: "2026-10-25" }));

    await createInvoicePayment("invoice-1", ACTOR);

    const callArgs = createUpperCharge.mock.calls[0][0];
    expect(callArgs.description.length).toBeLessThanOrEqual(140);
    expect(callArgs.description.endsWith("- Mensalidade BetLeads 10/2026")).toBe(true);
  });

  it("throws 'Esta fatura já está paga.' for a paid invoice", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ status: "paid" }));
    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Esta fatura já está paga.",
    );
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("throws 'Fatura não encontrada.' for a missing invoice", async () => {
    await expect(createInvoicePayment("does-not-exist", ACTOR)).rejects.toThrow(
      "Fatura não encontrada.",
    );
  });

  it("throws 'Fatura não encontrada.' for a canceled invoice", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow({ status: "canceled" }));
    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Fatura não encontrada.",
    );
  });

  it("throws the gateway-unavailable message when BILLING_INVOICES_ENABLED is off", async () => {
    process.env.BILLING_INVOICES_ENABLED = "false";
    fake.admin.rows("billing_invoices").push(invoiceRow());
    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Pagamento por Pix indisponível no momento.",
    );
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("throws the gateway-unavailable message when UPPER_API_KEY is missing", async () => {
    process.env.UPPER_API_KEY = "";
    fake.admin.rows("billing_invoices").push(invoiceRow());
    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Pagamento por Pix indisponível no momento.",
    );
    expect(createUpperCharge).not.toHaveBeenCalled();
  });

  it("marks the charge FAILED with a generic message when Upper fails", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    createUpperCharge.mockRejectedValue(
      new UpperError("Upper respondeu 502.", { status: 502, code: null, retryable: true }),
    );

    await expect(createInvoicePayment("invoice-1", ACTOR)).rejects.toThrow(
      "Não foi possível gerar o Pix agora. Tente de novo em instantes.",
    );

    const charge = fake.admin.rows("payment_charges")[0];
    expect(charge.status).toBe("FAILED");
    expect(JSON.stringify(charge.last_error)).not.toContain("502.");
  });

  it("retries once with n+1 on a unique external_id conflict", async () => {
    fake.admin.rows("billing_invoices").push(invoiceRow());
    // Pre-seed a row that will collide with the first computed external_id.
    fake.admin.rows("payment_charges").push({
      id: "ghost-charge",
      tenant_id: TENANT,
      kind: "credit_topup",
      ref_id: "unrelated",
      external_id: "bl-inv-invoice-1-1",
      status: "EXPIRED",
      amount_cents: 1,
    });

    const result = await createInvoicePayment("invoice-1", ACTOR);
    expect(result.chargeId).toBeTruthy();
    const created = fake.admin
      .rows("payment_charges")
      .find((r) => r.id === result.chargeId)!;
    expect(created.external_id).toBe("bl-inv-invoice-1-2");
  });
});

describe("cancelOpenInvoiceCharges", () => {
  it("cancels open charges at Upper and records them CANCELLED", async () => {
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-1",
      status: "ACTIVE",
      amount_cents: 400000,
    });
    fake.admin.rows("payment_charges").push({
      id: "charge-paid",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-1",
      external_id: "bl-inv-invoice-1-2",
      status: "PAID",
      amount_cents: 400000,
    });

    const result = await cancelOpenInvoiceCharges("invoice-1");

    expect(cancelUpperCharge).toHaveBeenCalledTimes(1);
    expect(cancelUpperCharge).toHaveBeenCalledWith("bl-inv-invoice-1-1");
    const charge = fake.admin.rows("payment_charges").find((r) => r.id === "charge-1")!;
    expect(charge.status).toBe("CANCELLED");
    const paidCharge = fake.admin.rows("payment_charges").find((r) => r.id === "charge-paid")!;
    expect(paidCharge.status).toBe("PAID");
    expect(result).toEqual({ canceled: 1, failed: [] });
  });

  it("does nothing when there is no open charge", async () => {
    await expect(cancelOpenInvoiceCharges("invoice-without-charges")).resolves.toEqual({
      canceled: 0,
      failed: [],
    });
    expect(cancelUpperCharge).not.toHaveBeenCalled();
  });

  it("reports a per-charge Upper failure instead of swallowing it", async () => {
    fake.admin.rows("payment_charges").push({
      id: "charge-2",
      tenant_id: TENANT,
      kind: "invoice",
      ref_id: "invoice-2",
      external_id: "bl-inv-invoice-2-1",
      status: "ACTIVE",
      amount_cents: 400000,
    });
    cancelUpperCharge.mockRejectedValueOnce(new Error("upper rejected cancel"));

    const result = await cancelOpenInvoiceCharges("invoice-2");

    expect(result).toEqual({
      canceled: 0,
      failed: [{ chargeId: "charge-2", error: "upper rejected cancel" }],
    });
  });
});
