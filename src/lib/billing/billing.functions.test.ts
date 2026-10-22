import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  adminClearTenantPriceFor,
  adminSetTenantPriceFor,
  getInvoiceReceiptFor,
  getPlanOverviewFor,
  getTenantEffectivePriceFor,
  payInvoiceFor,
} from "./billing.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000a0a9";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";
const MEMBER = "00000000-0000-4000-8000-0000000000cc";

/**
 * `admin_set_tenant_price`/`admin_clear_tenant_price` check `is_super_admin()`
 * with no service_role bypass: calling them through `supabaseAdmin`
 * (auth.uid() is null there) always fails with `forbidden`, even for a real
 * super admin. So the `supabaseAdmin` fake below registers those two RPCs to
 * fail exactly that way — proving the fix (and catching a regression back to
 * the bug) requires the code to call `ctx.supabase` (the separate `userDb`
 * fake, which registers a real, succeeding handler) instead.
 */
let userDb: ReturnType<typeof createFakeDb>;

function ctxFor(userId: string) {
  return { userId, supabase: userDb.client };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin.onRpc("billing_effective_price", (args) => ({
    data: { item: args._item, unit_price: 0.08, free_monthly_units: 0, exempt: false },
    error: null,
  }));
  fake.admin.onRpc("admin_set_tenant_price", () => ({
    data: null,
    error: { message: "forbidden" },
  }));
  fake.admin.onRpc("admin_clear_tenant_price", () => ({
    data: null,
    error: { message: "forbidden" },
  }));

  userDb = createFakeDb();
  userDb.onRpc("admin_set_tenant_price", (args) => ({
    data: {
      tenant_id: args._tenant,
      item: args._item,
      unit_price: args._unit_price,
      valid_from: new Date().toISOString(),
    },
    error: null,
  }));
  userDb.onRpc("admin_clear_tenant_price", (args) => ({
    data: {
      tenant_id: args._tenant,
      item: args._item,
      unit_price: null,
      valid_from: new Date().toISOString(),
    },
    error: null,
  }));
  // `resolveTenantForBilling`/`isTenantPayer` (Task 7's getPlanOverview,
  // payInvoice, getInvoiceReceipt) run through the user-scoped client.
  userDb.onRpc("is_super_admin", (args) => ({
    data: ((args?._user_id as string | undefined) ?? "") === SUPER_ADMIN,
    error: null,
  }));
  userDb.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
  userDb.rows("user_roles").push(
    { user_id: HOUSE_ADMIN, tenant_id: TENANT, role: "admin" },
    { user_id: MEMBER, tenant_id: TENANT, role: "member" },
  );
});

describe("adminSetTenantPriceFor — permission", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      adminSetTenantPriceFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, item: "sms", unitPrice: 0.07 }),
    ).rejects.toThrow(/super admin/i);
    expect(fake.admin.rows("tenant_audit_logs")).toHaveLength(0);
  });

  it("writes the override through the caller's own client, not supabaseAdmin", async () => {
    // Regression guard for the `forbidden` bug: if the code called
    // `supabaseAdmin.rpc("admin_set_tenant_price", ...)` instead of
    // `ctx.supabase`, this would reject with "forbidden" (see the
    // `supabaseAdmin` fake's handler above).
    const result = await adminSetTenantPriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
      unitPrice: 0.07,
    });
    expect(result).toEqual({ ok: true });
  });

  it("writes the override and an audit row (before/after) for the super admin", async () => {
    const result = await adminSetTenantPriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
      unitPrice: 0.07,
    });
    expect(result).toEqual({ ok: true });
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant_price.set",
      tenant_id: TENANT,
      metadata: { item: "sms", unit_price: 0.07 },
    });
  });

  it("accepts voice_30s and email, not only sms", async () => {
    await expect(
      adminSetTenantPriceFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        item: "voice_30s",
        unitPrice: 0.1,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      adminSetTenantPriceFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        item: "email",
        unitPrice: 0.003,
      }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("adminClearTenantPriceFor — permission", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      adminClearTenantPriceFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, item: "sms" }),
    ).rejects.toThrow(/super admin/i);
  });

  it("clears the override through the caller's own client, not supabaseAdmin", async () => {
    const result = await adminClearTenantPriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
    });
    expect(result).toEqual({ ok: true });
  });

  it("clears the override and audits it for the super admin", async () => {
    const result = await adminClearTenantPriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
    });
    expect(result).toEqual({ ok: true });
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "tenant_price.cleared" });
  });
});

describe("getTenantEffectivePriceFor", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      getTenantEffectivePriceFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, item: "sms" }),
    ).rejects.toThrow(/super admin/i);
  });

  it("returns the current unit price and whether it's an override", async () => {
    fake.admin.onRpc("billing_effective_price", (args) => ({
      data: { item: args._item, unit_price: 0.07, source: "override" },
      error: null,
    }));
    const result = await getTenantEffectivePriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
    });
    expect(result).toEqual({ unitPrice: 0.07, hasOverride: true });
  });

  it("reports hasOverride: false for the default price", async () => {
    fake.admin.onRpc("billing_effective_price", (args) => ({
      data: { item: args._item, unit_price: 0.08, source: "default" },
      error: null,
    }));
    const result = await getTenantEffectivePriceFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      item: "sms",
    });
    expect(result).toEqual({ unitPrice: 0.08, hasOverride: false });
  });
});

// ---------------------------------------------------------------------------
// Task 7 — getPlanOverview / payInvoice / getInvoiceReceipt
// ---------------------------------------------------------------------------

function setPlanAmount(baseCents: number, discountCents = 0) {
  fake.admin.onRpc("billing_monthly_amount", () => ({
    data: {
      base_cents: baseCents,
      discount_cents: discountCents,
      amount_cents: baseCents - discountCents,
    },
    error: null,
  }));
}

describe("getPlanOverviewFor", () => {
  beforeEach(() => {
    setPlanAmount(400000);
    fake.admin.rows("billing_plans").push({ code: "crm_unico", name: "Plano CRM", price_cents: 400000 });
  });

  it("an exempt house has no plan and no invoices", async () => {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "exempt",
      next_due_date: null,
    });
    fake.admin.rows("billing_invoices").push({
      id: "inv-leftover",
      tenant_id: TENANT,
      status: "canceled",
      due_date: "2026-10-01",
      cycle_due_date: "2026-10-01",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      amount_cents: 400000,
      discount_cents: 0,
      one_off_discount_cents: 0,
      paid_at: null,
      paid_via: null,
    });
    const result = await getPlanOverviewFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT });
    expect(result).toMatchObject({ exempt: true, plan: null, invoices: [], openInvoice: null });
  });

  it("a paying house with a continuous discount reports discountLabel", async () => {
    setPlanAmount(400000, 40000);
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "ok",
      discount_kind: "percent",
      discount_value: 10,
      next_due_date: "2026-12-05",
    });
    const result = await getPlanOverviewFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT });
    expect(result.exempt).toBe(false);
    expect(result.plan).toMatchObject({
      priceCents: 400000,
      discountedCents: 360000,
      discountLabel: "10% de desconto",
    });
  });

  it("canPay is false for a member", async () => {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "ok",
      next_due_date: "2026-12-05",
    });
    const result = await getPlanOverviewFor(ctxFor(MEMBER), { tenantId: TENANT });
    expect(result.canPay).toBe(false);
  });

  it("canPay is true for the admin", async () => {
    fake.admin.rows("tenant_billing").push({
      tenant_id: TENANT,
      plan_code: "crm_unico",
      access_state: "ok",
      next_due_date: "2026-12-05",
    });
    const result = await getPlanOverviewFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT });
    expect(result.canPay).toBe(true);
  });
});

describe("payInvoiceFor", () => {
  beforeEach(() => {
    fake.admin.rows("billing_invoices").push({
      id: "inv-open",
      tenant_id: TENANT,
      status: "open",
      due_date: "2026-11-05",
      cycle_due_date: "2026-11-05",
      amount_cents: 400000,
    });
    fake.admin.rows("billing_invoices").push({
      id: "inv-paid",
      tenant_id: TENANT,
      status: "paid",
      due_date: "2026-10-05",
      cycle_due_date: "2026-10-05",
      amount_cents: 400000,
    });
    fake.admin.rows("billing_invoices").push({
      id: "inv-other-tenant",
      tenant_id: OTHER_TENANT,
      status: "open",
      due_date: "2026-11-05",
      cycle_due_date: "2026-11-05",
      amount_cents: 400000,
    });
  });

  it("refuses a member", async () => {
    await expect(
      payInvoiceFor(ctxFor(MEMBER), { tenantId: TENANT, invoiceId: "inv-open" }),
    ).rejects.toThrow("Peça ao administrador da casa para pagar a mensalidade.");
  });

  it("refuses an invoice belonging to another house", async () => {
    await expect(
      payInvoiceFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, invoiceId: "inv-other-tenant" }),
    ).rejects.toThrow("Fatura não encontrada.");
  });

  it("refuses an invoice that is already paid", async () => {
    vi.stubEnv("BILLING_INVOICES_ENABLED", "true");
    vi.stubEnv("UPPER_API_KEY", "test-key");
    await expect(
      payInvoiceFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, invoiceId: "inv-paid" }),
    ).rejects.toThrow("Esta fatura já está paga.");
    vi.unstubAllEnvs();
  });
});

describe("getInvoiceReceiptFor", () => {
  it("refuses an open invoice", async () => {
    fake.admin.rows("billing_invoices").push({
      id: "inv-open",
      tenant_id: TENANT,
      status: "open",
      cycle_due_date: "2026-11-05",
      period_start: "2026-11-05",
      period_end: "2026-12-04",
      amount_cents: 400000,
      paid_at: null,
      paid_via: null,
      payment_charge_id: null,
    });
    await expect(
      getInvoiceReceiptFor(ctxFor(HOUSE_ADMIN), { tenantId: TENANT, invoiceId: "inv-open" }),
    ).rejects.toThrow("Esta fatura ainda não foi paga.");
  });

  it("returns the endToEndId from last_provider_payload when present, else the external_id", async () => {
    fake.admin.rows("payment_charges").push({
      id: "charge-1",
      external_id: "bl-inv-inv-paid-1",
      last_provider_payload: { endToEndId: "E12345" },
    });
    fake.admin.rows("billing_invoices").push({
      id: "inv-paid",
      tenant_id: TENANT,
      status: "paid",
      cycle_due_date: "2026-10-05",
      period_start: "2026-10-05",
      period_end: "2026-11-04",
      amount_cents: 400000,
      paid_amount_cents: 400000,
      paid_at: "2026-10-05T12:00:00Z",
      paid_via: "pix",
      payment_charge_id: "charge-1",
    });
    const receipt = await getInvoiceReceiptFor(ctxFor(HOUSE_ADMIN), {
      tenantId: TENANT,
      invoiceId: "inv-paid",
    });
    expect(receipt).toMatchObject({
      amountCents: 400000,
      paidVia: "pix",
      endToEndOrExternalId: "E12345",
    });
  });
});
