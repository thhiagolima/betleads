import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

const { cancelOpenInvoiceCharges } = vi.hoisted(() => ({ cancelOpenInvoiceCharges: vi.fn() }));
vi.mock("./invoices.server", () => ({ cancelOpenInvoiceCharges }));

const { sendBillingEmail } = vi.hoisted(() => ({ sendBillingEmail: vi.fn() }));
vi.mock("./billing-emails.server", () => ({ sendBillingEmail }));

vi.mock("@/lib/tenant-access.server", () => ({ listDemoTenantIds: vi.fn(async () => [] as string[]) }));

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { brtDayKey } from "@/lib/tz";
import {
  adminApplyInvoiceDiscountFor,
  adminBillingDashboardFor,
  adminBillingMonthlyCsvFor,
  adminBillingTenantListFor,
  adminCancelInvoiceFor,
  adminExtendInvoiceDueFor,
  adminGrantFreeDaysFor,
  adminManualSettleFor,
  adminResendBillingEmailFor,
  adminSetContinuousDiscountFor,
  adminSetCustomPriceFor,
  adminSetCycleDayFor,
  adminSetFrozenFor,
  adminSetPixFeeFor,
  adminSetTenantBlockFor,
  adminTenantBillingHistoryFor,
  CANCEL_INVOICE_MESSAGE,
} from "./billing-admin.functions";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000bb";
const INVOICE = "00000000-0000-4000-8000-0000000000cc";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000dd";
const PLAIN_USER = "00000000-0000-4000-8000-0000000000ee";

let userDb: ReturnType<typeof createFakeDb>;

function ctxFor(userId: string) {
  return { userId, supabase: userDb.client };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER_ADMIN, error: null }));

  userDb = createFakeDb();
  cancelOpenInvoiceCharges.mockReset().mockResolvedValue({ canceled: 0, failed: [] });
  sendBillingEmail.mockReset().mockResolvedValue({ sent: true, recipients: 2 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A plausible RPC jsonb result from billing_admin_result().
function rpcOk(tenantId: string, extra: Record<string, unknown> = {}) {
  return { data: { ok: true, tenant_id: tenantId, access_state: "ok", next_due_date: null, ...extra }, error: null };
}

describe("adminSetTenantBlockFor", () => {
  beforeEach(() => {
    userDb.onRpc("billing_admin_set_block", () => rpcOk(TENANT));
  });

  it("refuses a non-super-admin", async () => {
    await expect(
      adminSetTenantBlockFor(ctxFor(PLAIN_USER), { tenantId: TENANT, blocked: true, reason: "atraso" }),
    ).rejects.toThrow("Apenas o super admin pode realizar esta ação.");
  });

  it("refuses a reason shorter than 5 characters", async () => {
    await expect(
      adminSetTenantBlockFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, blocked: true, reason: "ok" }),
    ).rejects.toThrow(/5 caracteres/);
  });

  it("calls the RPC through the caller's own client, not supabaseAdmin", async () => {
    const spy = vi.spyOn(userDb.client, "rpc");
    await adminSetTenantBlockFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, blocked: true, reason: "atraso grave" });
    expect(spy).toHaveBeenCalledWith(
      "billing_admin_set_block",
      expect.objectContaining({ _tenant: TENANT, _blocked: true, _reason: "atraso grave" }),
    );
    // supabaseAdmin (the fake `admin` db) must never see this RPC.
    expect(() => fake.admin.client.rpc).toBeDefined();
  });

  it("writes a billing.set_block audit row with the reason", async () => {
    await adminSetTenantBlockFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, blocked: true, reason: "atraso grave" });
    const logs = fake.admin.rows("tenant_audit_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      tenant_id: TENANT,
      actor_user_id: SUPER_ADMIN,
      action: "billing.set_block",
    });
    expect((logs[0].metadata as Record<string, unknown>).reason).toBe("atraso grave");
  });

  it("translates a forbidden RPC error (super admin check inside SQL) to pt-BR", async () => {
    userDb.onRpc("billing_admin_set_block", () => ({ data: null, error: { message: "forbidden" } }));
    await expect(
      adminSetTenantBlockFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, blocked: true, reason: "atraso grave" }),
    ).rejects.toThrow("Apenas o super admin pode realizar esta ação.");
  });

  it("translates tenant_not_found", async () => {
    userDb.onRpc("billing_admin_set_block", () => ({ data: null, error: { message: "tenant_not_found" } }));
    await expect(
      adminSetTenantBlockFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, blocked: true, reason: "atraso grave" }),
    ).rejects.toThrow("Casa não encontrada.");
  });
});

describe("adminExtendInvoiceDueFor", () => {
  it("translates invoice_not_open", async () => {
    userDb.onRpc("billing_admin_extend_due", () => ({ data: null, error: { message: "invoice_not_open" } }));
    await expect(
      adminExtendInvoiceDueFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, days: 5, reason: "pedido do cliente" }),
    ).rejects.toThrow("Só faturas em aberto podem ser alteradas.");
  });

  it("audits billing.extend_due with the resolved tenant from the RPC result", async () => {
    userDb.onRpc("billing_admin_extend_due", () => rpcOk(TENANT));
    await adminExtendInvoiceDueFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, days: 5, reason: "pedido do cliente" });
    expect(fake.admin.rows("tenant_audit_logs")[0]).toMatchObject({ tenant_id: TENANT, action: "billing.extend_due" });
  });

  it("translates invalid_days", async () => {
    userDb.onRpc("billing_admin_extend_due", () => ({ data: null, error: { message: "invalid_days" } }));
    await expect(
      adminExtendInvoiceDueFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, days: 5, reason: "pedido do cliente" }),
    ).rejects.toThrow("Número de dias inválido.");
  });
});

describe("adminGrantFreeDaysFor", () => {
  it("refuses a non-super-admin and a short reason", async () => {
    userDb.onRpc("billing_admin_free_days", () => rpcOk(TENANT));
    await expect(
      adminGrantFreeDaysFor(ctxFor(PLAIN_USER), { tenantId: TENANT, days: 10, reason: "cortesia" }),
    ).rejects.toThrow("Apenas o super admin");
    await expect(
      adminGrantFreeDaysFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, days: 10, reason: "ok" }),
    ).rejects.toThrow(/5 caracteres/);
  });

  it("translates tenant_exempt", async () => {
    userDb.onRpc("billing_admin_free_days", () => ({ data: null, error: { message: "tenant_exempt" } }));
    await expect(
      adminGrantFreeDaysFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, days: 10, reason: "cortesia" }),
    ).rejects.toThrow("Casas isentas não recebem ações de cobrança.");
  });
});

describe("adminApplyInvoiceDiscountFor", () => {
  beforeEach(() => {
    userDb.onRpc("billing_admin_one_off_discount", () => rpcOk(TENANT));
  });

  it("cancels the open Pix charges of the invoice before discounting", async () => {
    await adminApplyInvoiceDiscountFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      kind: "percent",
      value: 10,
      reason: "negociação comercial",
    });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledTimes(1);
  });

  it("still applies the discount and logs the per-charge Upper failure in the audit metadata (audit truth)", async () => {
    cancelOpenInvoiceCharges.mockResolvedValueOnce({
      canceled: 0,
      failed: [{ chargeId: "charge-1", error: "upper rejected cancel" }],
    });
    const result = await adminApplyInvoiceDiscountFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      kind: "percent",
      value: 10,
      reason: "negociação comercial",
    });
    expect(result).toMatchObject({ tenant_id: TENANT });
    const metadata = fake.admin.rows("tenant_audit_logs")[0].metadata as Record<string, unknown>;
    // ok must be false — the action still completed, but the audit truthfully
    // records that Upper rejected the cancel (I1: no more ok:true on failure).
    expect(metadata.pixCancel).toMatchObject({
      attempted: true,
      ok: false,
      canceled: 0,
      failed: [{ chargeId: "charge-1", error: "upper rejected cancel" }],
    });
  });

  it("still completes and marks pixCancel.ok false when cancelOpenInvoiceCharges itself throws", async () => {
    cancelOpenInvoiceCharges.mockRejectedValueOnce(new Error("upper down"));
    const result = await adminApplyInvoiceDiscountFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      kind: "percent",
      value: 10,
      reason: "negociação comercial",
    });
    expect(result).toMatchObject({ tenant_id: TENANT });
    const metadata = fake.admin.rows("tenant_audit_logs")[0].metadata as Record<string, unknown>;
    expect(metadata.pixCancel).toMatchObject({ attempted: true, ok: false });
  });

  it("translates amount_below_pix_minimum using the SQL DETAIL text", async () => {
    userDb.onRpc("billing_admin_one_off_discount", () => ({
      data: null,
      error: { message: "amount_below_pix_minimum", details: "O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)" },
    }));
    await expect(
      adminApplyInvoiceDiscountFor(ctxFor(SUPER_ADMIN), {
        invoiceId: INVOICE,
        kind: "percent",
        value: 99,
        reason: "negociação comercial",
      }),
    ).rejects.toThrow("O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)");
  });
});

describe("adminSetContinuousDiscountFor", () => {
  beforeEach(() => {
    userDb.onRpc("billing_admin_set_continuous_discount", () => rpcOk(TENANT));
  });

  it("cancels the tenant's open invoice Pix before repricing", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    await adminSetContinuousDiscountFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      kind: "fixed",
      value: 50000,
      startsOn: null,
      endsOn: null,
      reason: "desconto fixo negociado",
    });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
  });

  it("does nothing to Pix when there is no open invoice", async () => {
    await adminSetContinuousDiscountFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      kind: "fixed",
      value: 50000,
      startsOn: null,
      endsOn: null,
      reason: "desconto fixo negociado",
    });
    expect(cancelOpenInvoiceCharges).not.toHaveBeenCalled();
  });
});

describe("adminManualSettleFor", () => {
  it("audits billing.manual_settle with the note and receipt", async () => {
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      paidAmountCents: 400000,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    const log = fake.admin.rows("tenant_audit_logs")[0];
    expect(log).toMatchObject({ tenant_id: TENANT, action: "billing.manual_settle" });
    expect((log.metadata as Record<string, unknown>).note).toBe("Pago via TED");
  });

  it("cancels the invoice's open Pix before the settle and audits pixCancel", async () => {
    const order: string[] = [];
    cancelOpenInvoiceCharges.mockImplementationOnce(async () => {
      order.push("cancel");
      return { canceled: 1, failed: [] };
    });
    userDb.onRpc("billing_admin_manual_settle", () => {
      order.push("settle");
      return { data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE }, error: null };
    });
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
    expect(order).toEqual(["cancel", "settle"]);
    const metadata = fake.admin.rows("tenant_audit_logs")[0].metadata as Record<string, unknown>;
    expect(metadata.pixCancel).toEqual({ attempted: true, ok: true, canceled: 1, failed: [] });
  });

  it("passes paidAt through as 12:00 BRT of that day, and audits it", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    userDb.onRpc("billing_admin_manual_settle", (args) => {
      capturedArgs = args;
      return { data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE }, error: null };
    });
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
      paidAt: "2026-11-08",
    });
    // 2026-11-08 12:00 BRT = 2026-11-08T15:00:00.000Z.
    expect(capturedArgs?._paid_at).toBe("2026-11-08T15:00:00.000Z");
    const metadata = fake.admin.rows("tenant_audit_logs")[0].metadata as Record<string, unknown>;
    expect(metadata.paidAt).toBe("2026-11-08");
  });

  it("omits paidAt (null) when not given, keeping today's behaviour", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    userDb.onRpc("billing_admin_manual_settle", (args) => {
      capturedArgs = args;
      return { data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE }, error: null };
    });
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    expect(capturedArgs?._paid_at).toBeNull();
  });

  it("still settles when the Upper cancel fails, recording it in the audit", async () => {
    cancelOpenInvoiceCharges.mockRejectedValueOnce(new Error("upper down"));
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    const result = await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    expect(result).toMatchObject({ tenant_id: TENANT });
    const metadata = fake.admin.rows("tenant_audit_logs")[0].metadata as Record<string, unknown>;
    expect(metadata.pixCancel).toMatchObject({ attempted: true, ok: false });
  });

  // Fix round 1, Ruling T10 — item 1.
  it("sends the 'paid' e-mail best-effort after a successful settle", async () => {
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    expect(sendBillingEmail).toHaveBeenCalledWith(INVOICE, "paid");
  });

  it("still returns the settle result when sending the 'paid' e-mail fails (logs, never throws)", async () => {
    sendBillingEmail.mockRejectedValueOnce(new Error("infobip down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    const result = await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
    });
    expect(result).toMatchObject({ tenant_id: TENANT });
    expect(errorSpy).toHaveBeenCalledWith(
      "[billing-admin] could not send the 'paid' e-mail after a manual settle",
      expect.objectContaining({ invoiceId: INVOICE }),
    );
  });

  it("sends the 'paid' e-mail even when the settle is backdated more than 48h (the hourly sweep's lookback would otherwise miss it)", async () => {
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
      paidAt: "2026-01-01", // far more than 48h in the past.
    });
    expect(sendBillingEmail).toHaveBeenCalledWith(INVOICE, "paid");
  });

  // Fix round 1, Ruling T10 — item 2 (server-side mapped error).
  it("translates invalid_paid_at to the pt-BR message", async () => {
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: null,
      error: { message: "invalid_paid_at" },
    }));
    await expect(
      adminManualSettleFor(ctxFor(SUPER_ADMIN), {
        invoiceId: INVOICE,
        note: "Pago via TED",
        receipt: "comprovante-123",
        reason: "pagamento fora do Pix",
        paidAt: "2026-01-01",
      }),
    ).rejects.toThrow("A data do pagamento não pode ser anterior à emissão da fatura.");
  });

  // Fix round 1, Ruling T10 — item 3 (zod rejects an impossible calendar date before the RPC).
  it("rejects an impossible calendar date (2026-02-30) for paidAt without calling the RPC", async () => {
    userDb.onRpc("billing_admin_manual_settle", () => ({
      data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE },
      error: null,
    }));
    await expect(
      adminManualSettleFor(ctxFor(SUPER_ADMIN), {
        invoiceId: INVOICE,
        note: "Pago via TED",
        receipt: "comprovante-123",
        reason: "pagamento fora do Pix",
        paidAt: "2026-02-30",
      }),
    ).rejects.toThrow();
  });

  // Fix round 1, Ruling T10 — item 4.
  it("sends null (paid_at = now()) when paidAt is today's Brasília day", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    userDb.onRpc("billing_admin_manual_settle", (args) => {
      capturedArgs = args;
      return { data: { ok: true, tenant_id: TENANT, invoice_id: INVOICE }, error: null };
    });
    const todayBRT = brtDayKey(new Date());
    await adminManualSettleFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      note: "Pago via TED",
      receipt: "comprovante-123",
      reason: "pagamento fora do Pix",
      paidAt: todayBRT,
    });
    expect(capturedArgs?._paid_at).toBeNull();
  });
});

describe("adminCancelInvoiceFor", () => {
  it("cancels open Pix charges, cancels the invoice, and returns the fixed reissue message", async () => {
    userDb.onRpc("billing_admin_cancel_invoice", () => rpcOk(TENANT));
    const result = await adminCancelInvoiceFor(ctxFor(SUPER_ADMIN), {
      invoiceId: INVOICE,
      reason: "fatura gerada por engano",
    });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
    expect(result.message).toBe(CANCEL_INVOICE_MESSAGE);
  });
});

describe("adminSetCycleDayFor", () => {
  it("translates invalid_date", async () => {
    userDb.onRpc("billing_admin_set_cycle_day", () => ({ data: null, error: { message: "invalid_date" } }));
    await expect(
      adminSetCycleDayFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, nextDueDate: "2026-01-01", reason: "ajuste de ciclo" }),
    ).rejects.toThrow("Data inválida.");
  });
});

describe("adminSetFrozenFor", () => {
  it("cancels the open invoice's Pix charges when freezing", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    userDb.onRpc("billing_admin_set_frozen", () => rpcOk(TENANT));
    await adminSetFrozenFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, frozen: true, reason: "pausa negociada" });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
  });

  it("does not try to cancel Pix when unfreezing", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    userDb.onRpc("billing_admin_set_frozen", () => rpcOk(TENANT));
    await adminSetFrozenFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, frozen: false, reason: "retomando cobrança" });
    expect(cancelOpenInvoiceCharges).not.toHaveBeenCalled();
  });
});

describe("adminSetCustomPriceFor", () => {
  it("cancels the open invoice's Pix charges before repricing", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    userDb.onRpc("billing_admin_set_custom_price", () => rpcOk(TENANT));
    await adminSetCustomPriceFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT, priceCents: 300000, reason: "preço especial" });
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
  });
});

describe("adminResendBillingEmailFor", () => {
  it("resends the last e-mail kind logged for the open invoice", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    fake.admin.rows("billing_email_log").push({ invoice_id: INVOICE, kind: "due_today", sent_at: "2026-10-20T10:00:00Z" });
    const result = await adminResendBillingEmailFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, reason: "cliente pediu reenvio" });
    expect(sendBillingEmail).toHaveBeenCalledWith(INVOICE, "due_today", { force: true });
    expect(result).toMatchObject({ ok: true, kind: "due_today", sent: true });
  });

  it("defaults to 'issued' when nothing was logged yet", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "open" });
    await adminResendBillingEmailFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, reason: "cliente pediu reenvio" });
    expect(sendBillingEmail).toHaveBeenCalledWith(INVOICE, "issued", { force: true });
  });

  it("refuses a closed invoice", async () => {
    fake.admin.rows("billing_invoices").push({ id: INVOICE, tenant_id: TENANT, status: "paid" });
    await expect(
      adminResendBillingEmailFor(ctxFor(SUPER_ADMIN), { invoiceId: INVOICE, reason: "cliente pediu reenvio" }),
    ).rejects.toThrow("Só faturas em aberto podem ser alteradas.");
  });
});

describe("adminSetPixFeeFor", () => {
  it("inserts a new payment_fee_settings row", async () => {
    await adminSetPixFeeFor(ctxFor(SUPER_ADMIN), { feePercent: 1.5, feeFixedCents: 50, reason: "nova taxa da Upper" });
    const rows = fake.admin.rows("payment_fee_settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "upper", fee_percent: 1.5, fee_fixed_cents: 50, updated_by: SUPER_ADMIN });
  });

  it("refuses a non-super-admin", async () => {
    await expect(
      adminSetPixFeeFor(ctxFor(PLAIN_USER), { feePercent: 1, feeFixedCents: 0, reason: "nova taxa da Upper" }),
    ).rejects.toThrow("Apenas o super admin");
  });
});

describe("adminBillingDashboardFor", () => {
  it("sums MRR from paying, non-frozen houses, net of the active continuous discount", async () => {
    fake.admin.rows("tenants").push(
      { id: TENANT, plano: "crm_unico" },
      { id: OTHER_TENANT, plano: "interno" },
    );
    fake.admin.rows("billing_plans").push(
      { code: "crm_unico", price_cents: 400000, exempt_all: false },
      { code: "interno", price_cents: 0, exempt_all: true },
    );
    fake.admin.rows("tenant_billing").push(
      {
        tenant_id: TENANT,
        plan_code: "crm_unico",
        custom_price_cents: null,
        discount_kind: "percent",
        discount_value: 10,
        discount_starts_on: null,
        discount_ends_on: null,
        frozen: false,
        access_state: "ok",
      },
      {
        tenant_id: OTHER_TENANT,
        plan_code: "crm_unico",
        custom_price_cents: null,
        discount_kind: null,
        discount_value: null,
        discount_starts_on: null,
        discount_ends_on: null,
        frozen: false,
        access_state: "exempt",
      },
    );
    const result = await adminBillingDashboardFor(ctxFor(SUPER_ADMIN));
    // 400000 - 10% = 360000; the exempt house contributes nothing.
    expect(result.mrrCents).toBe(360000);
  });

  it("excludes frozen houses from MRR", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      custom_price_cents: null,
      discount_kind: null,
      discount_value: null,
      discount_starts_on: null,
      discount_ends_on: null,
      frozen: true,
      access_state: "frozen",
    });
    const result = await adminBillingDashboardFor(ctxFor(SUPER_ADMIN));
    expect(result.mrrCents).toBe(0);
    expect(result.frozen).toBe(1);
  });

  it("counts needsReview charges and locked states from tenant_billing", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      custom_price_cents: null,
      discount_kind: null,
      discount_value: null,
      discount_starts_on: null,
      discount_ends_on: null,
      frozen: false,
      access_state: "locked_unpaid",
    });
    fake.admin.rows("payment_charges").push(
      { id: "c1", needs_review: true, credited_at: null },
      { id: "c2", needs_review: true, credited_at: "2026-10-01T00:00:00Z" },
    );
    const result = await adminBillingDashboardFor(ctxFor(SUPER_ADMIN));
    expect(result.lockedUnpaid).toBe(1);
    expect(result.needsReview).toBe(1);
  });

  it("refuses a non-super-admin", async () => {
    await expect(adminBillingDashboardFor(ctxFor(PLAIN_USER))).rejects.toThrow("Apenas o super admin");
  });
});

describe("adminTenantBillingHistoryFor", () => {
  it("merges invoices, charges and billing audit logs, sorted descending", async () => {
    fake.admin.rows("billing_invoices").push({
      id: INVOICE,
      tenant_id: TENANT,
      amount_cents: 400000,
      due_date: "2026-11-05",
      status: "paid",
      paid_at: "2026-10-10T12:00:00Z",
      paid_via: "pix",
      canceled_reason: null,
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-10T12:00:00Z",
    });
    fake.admin.rows("tenant_audit_logs").push(
      {
        id: "log1",
        tenant_id: TENANT,
        action: "billing.extend_due",
        metadata: { reason: "pedido do cliente" },
        actor_user_id: SUPER_ADMIN,
        created_at: "2026-10-05T12:00:00Z",
      },
      {
        id: "log2",
        tenant_id: TENANT,
        action: "tenant.renamed",
        metadata: { reason: "não deveria aparecer" },
        actor_user_id: SUPER_ADMIN,
        created_at: "2026-10-06T12:00:00Z",
      },
    );
    const items = await adminTenantBillingHistoryFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT });
    expect(items.map((i) => i.kind)).toEqual(["invoice_paid", "audit", "invoice_created"]);
    expect(items.every((i) => i.title !== "tenant.renamed")).toBe(true);
  });

  it("falls back to 'Superadmin <id>' when there is no cheap email to resolve (ruling 2)", async () => {
    fake.admin.rows("tenant_audit_logs").push({
      id: "log1",
      tenant_id: TENANT,
      action: "billing.extend_due",
      metadata: { reason: "pedido do cliente" },
      actor_user_id: SUPER_ADMIN,
      created_at: "2026-10-05T12:00:00Z",
    });
    const items = await adminTenantBillingHistoryFor(ctxFor(SUPER_ADMIN), { tenantId: TENANT });
    const auditItem = items.find((i) => i.kind === "audit");
    // The test double's supabaseAdmin has no `.auth.admin.getUserById`, so the
    // email lookup can't resolve — this must fall back to the short-id label,
    // never throw.
    expect(auditItem?.actor).toBe(`Superadmin ${SUPER_ADMIN.slice(0, 8)}`);
  });
});

describe("adminBillingTenantListFor", () => {
  it("refuses a non-super-admin", async () => {
    await expect(adminBillingTenantListFor(ctxFor(PLAIN_USER))).rejects.toThrow(
      "Apenas o super admin",
    );
  });

  it("lists every tenant with its billing situation, open invoice, custom price and discount", async () => {
    fake.admin.rows("tenants").push(
      { id: TENANT, nome: "Casa Paga", slug: "casa-paga" },
      { id: OTHER_TENANT, nome: "Casa Isenta", slug: "casa-isenta" },
    );
    fake.admin.rows("tenant_billing").push(
      {
        tenant_id: TENANT,
        plan_code: "crm_unico",
        access_state: "overdue",
        frozen: false,
        manual_block: false,
        next_due_date: "2026-11-05",
        custom_price_cents: 350000,
        discount_kind: "percent",
        discount_value: 10,
        discount_starts_on: null,
        discount_ends_on: null,
      },
      {
        tenant_id: OTHER_TENANT,
        plan_code: "interno",
        access_state: "exempt",
        frozen: false,
        manual_block: false,
        next_due_date: null,
        custom_price_cents: null,
        discount_kind: null,
        discount_value: null,
        discount_starts_on: null,
        discount_ends_on: null,
      },
    );
    fake.admin.rows("billing_invoices").push({
      id: INVOICE,
      tenant_id: TENANT,
      status: "open",
      amount_cents: 315000,
      due_date: "2026-11-05",
      created_at: "2026-10-05T14:00:00.000Z",
    });

    const rows = await adminBillingTenantListFor(ctxFor(SUPER_ADMIN));
    expect(rows).toHaveLength(2);

    const paying = rows.find((r) => r.tenantId === TENANT);
    expect(paying).toMatchObject({
      name: "Casa Paga",
      slug: "casa-paga",
      planCode: "crm_unico",
      accessState: "overdue",
      frozen: false,
      manualBlock: false,
      nextDueDate: "2026-11-05",
      customPriceCents: 350000,
      continuousDiscount: { kind: "percent", value: 10, startsOn: null, endsOn: null },
      openInvoice: {
        id: INVOICE,
        amountCents: 315000,
        dueDate: "2026-11-05",
        phase: "overdue",
        issuedOn: "2026-10-05",
      },
    });

    const exempt = rows.find((r) => r.tenantId === OTHER_TENANT);
    expect(exempt).toMatchObject({
      name: "Casa Isenta",
      accessState: "exempt",
      openInvoice: null,
      customPriceCents: null,
      continuousDiscount: null,
    });
  });

  it("marks an open invoice with no warning-window access_state as phase 'open'", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Nova", slug: "casa-nova" });
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "ok",
      frozen: false,
      manual_block: false,
      next_due_date: "2026-12-01",
      custom_price_cents: null,
      discount_kind: null,
      discount_value: null,
      discount_starts_on: null,
      discount_ends_on: null,
    });
    fake.admin.rows("billing_invoices").push({
      id: INVOICE,
      tenant_id: TENANT,
      status: "open",
      amount_cents: 400000,
      due_date: "2026-12-05",
    });

    const rows = await adminBillingTenantListFor(ctxFor(SUPER_ADMIN));
    expect(rows[0].openInvoice?.phase).toBe("open");
  });

  it("reads manualBlock from tenant_billing.manual_block, not from access_state (fix round 1, I1)", async () => {
    // A frozen AND manually-blocked house still reports access_state "frozen" (precedence:
    // exempt > frozen > locked_manual > ...), so deriving the block toggle from
    // `accessState === "locked_manual"` would read it as unblocked. `manual_block` is the
    // superadmin's own, independent toggle.
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Congelada e Bloqueada", slug: "casa-fb" });
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "frozen",
      frozen: true,
      manual_block: true,
      next_due_date: null,
      custom_price_cents: null,
      discount_kind: null,
      discount_value: null,
      discount_starts_on: null,
      discount_ends_on: null,
    });

    const rows = await adminBillingTenantListFor(ctxFor(SUPER_ADMIN));
    expect(rows[0]).toMatchObject({ accessState: "frozen", frozen: true, manualBlock: true });
  });

  it("pages tenants AND tenant_billing past PostgREST's 1000-row cap (fix round 1, I2)", async () => {
    const tenants = fake.admin.rows("tenants");
    const tenantBilling = fake.admin.rows("tenant_billing");
    for (let i = 0; i < 1500; i += 1) {
      const id = `tenant-${String(i).padStart(5, "0")}`;
      tenants.push({ id, nome: `Casa ${i}`, slug: `casa-${i}` });
      tenantBilling.push({
        tenant_id: id,
        plan_code: "crm_unico",
        access_state: "ok",
        frozen: false,
        manual_block: false,
        next_due_date: null,
        custom_price_cents: null,
        discount_kind: null,
        discount_value: null,
        discount_starts_on: null,
        discount_ends_on: null,
      });
    }
    const rows = await adminBillingTenantListFor(ctxFor(SUPER_ADMIN));
    expect(rows).toHaveLength(1500);
    // If tenant_billing were truncated at 1000 rows, the remaining 500 tenants would fall back
    // to the "no tenant_billing row" defaults (planCode "", accessState "ok" default) instead
    // of the "crm_unico" plan code pushed above for every one of the 1500.
    expect(rows.every((r) => r.planCode === "crm_unico")).toBe(true);
  });
});

describe("adminBillingMonthlyCsvFor", () => {
  it("has the exact header and lists exempt houses after paying ones", async () => {
    fake.admin.rows("tenants").push(
      { id: TENANT, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico" },
      { id: OTHER_TENANT, nome: "Casa Isenta", slug: "casa-isenta", plano: "interno" },
    );
    fake.admin.rows("billing_plans").push(
      { code: "crm_unico", price_cents: 400000, exempt_all: false },
      { code: "interno", price_cents: 0, exempt_all: true },
    );
    fake.admin.rows("billing_invoices").push({
      tenant_id: TENANT,
      status: "paid",
      paid_amount_cents: 400000,
      paid_at: "2026-10-10T12:00:00Z",
    });

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    const lines = csv.replace(/^\uFEFF/, "").split("\n");
    // I4: no pre-existing `receita` column, so `receita_bruta` is added right before
    // `receita_liquida`; the rest of the header is unchanged.
    expect(lines[0]).toBe(
      "casa;slug;plano;mensalidade_paga;creditos_comprados;consumo_sms;consumo_voz;consumo_email;custo_fornecedor;taxa_pix;receita_bruta;receita_liquida;margem;isenta",
    );
    expect(lines[1]).toContain('"Casa Paga"');
    expect(lines[1].endsWith(";não")).toBe(true);
    expect(lines[2]).toContain('"Casa Isenta"');
    expect(lines[2].endsWith(";sim")).toBe(true);
  });

  it("computes receita_bruta/receita_liquida/margem per ruling I4, excluding creditos from receita", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Paga", slug: "casa-paga", plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
    fake.admin.rows("billing_invoices").push({
      id: "inv-1",
      tenant_id: TENANT,
      status: "paid",
      paid_amount_cents: 400000, // R$ 4000,00 mensalidade
      paid_at: "2026-10-10T12:00:00Z",
    });
    // Large, unrelated credit top-up: must NOT count toward receita/margem (I4 ruling), only
    // toward the informational creditos_comprados column.
    fake.admin.rows("payment_charges").push({
      id: "charge-topup-1",
      tenant_id: TENANT,
      kind: "credit_topup",
      paid_amount_cents: 900000,
      credited_at: "2026-10-05T12:00:00Z",
    });

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    const cells = csv.replace(/^\uFEFF/, "").split("\n")[1].split(";");
    // casa;slug;plano;mensalidade_paga;creditos_comprados;consumo_sms;consumo_voz;consumo_email;
    // custo_fornecedor;taxa_pix;receita_bruta;receita_liquida;margem;isenta
    expect(cells[3]).toBe("4000,00"); // mensalidade_paga
    expect(cells[4]).toBe("9000,00"); // creditos_comprados (informational only)
    expect(cells[10]).toBe("4000,00"); // receita_bruta = mensalidade (no consumo/fee here)
    expect(cells[11]).toBe("4000,00"); // receita_liquida = receita_bruta (no custo/taxa here)
    expect(cells[12]).toBe("100,00"); // margem = receita_liquida / receita_bruta * 100, no "%"
  });

  it("leaves margem empty when receita is 0, instead of dividing by zero", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Sem Receita", slug: "casa-x", plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    const cells = csv.replace(/^\uFEFF/, "").split("\n")[1].split(";");
    expect(cells[10]).toBe("0,00"); // receita_bruta
    expect(cells[12]).toBe(""); // margem: empty, not NaN or "0,00"
  });

  it("neutralizes CSV formula injection in casa/slug/plano (I2)", async () => {
    fake.admin.rows("tenants").push({
      id: TENANT,
      nome: '=HYPERLINK("http://evil")',
      slug: "+cmd|'calc'!A0",
      plano: "crm_unico",
    });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    const line = csv.replace(/^\uFEFF/, "").split("\n")[1];
    // neutralizeCsvFormula prefixes a leading apostrophe before the cell is quoted, so a
    // spreadsheet never runs the house's name/slug as a formula.
    expect(line).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(line).toContain("\"'+cmd|'calc'!A0\"");
  });

  it("sums a paginated source past PostgREST's 1000-row cap (I3)", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Grande", slug: "casa-grande", plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });
    const invoices = fake.admin.rows("billing_invoices");
    for (let i = 0; i < 1500; i += 1) {
      invoices.push({
        id: `inv-${String(i).padStart(5, "0")}`,
        tenant_id: TENANT,
        status: "paid",
        paid_amount_cents: 100,
        paid_at: "2026-10-10T12:00:00Z",
      });
    }

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    const cells = csv.replace(/^\uFEFF/, "").split("\n")[1].split(";");
    // 1500 rows * R$ 1,00 = R$ 1500,00 — if capped at 1000 rows this would read 1000,00.
    expect(cells[3]).toBe("1500,00");
  });

  it("excludes demo tenants entirely", async () => {
    const { listDemoTenantIds } = await import("@/lib/tenant-access.server");
    (listDemoTenantIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([TENANT]);
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Demo", slug: "demo", plano: "crm_unico" });
    fake.admin.rows("billing_plans").push({ code: "crm_unico", price_cents: 400000, exempt_all: false });

    const csv = await adminBillingMonthlyCsvFor(ctxFor(SUPER_ADMIN), { month: "2026-10" });
    expect(csv).not.toContain("Casa Demo");
  });
});
