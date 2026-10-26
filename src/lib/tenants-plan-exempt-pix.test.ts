// Final fix (minor 1): when a plan change makes a house exempt, the plano
// trigger cancels its open invoice in SQL; updateTenantSettingsFor must then
// cancel that invoice's Pix charges at Upper (best-effort).
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
    },
  };
});

vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantNotDemo: vi.fn(async () => {}),
}));

const { cancelOpenInvoiceCharges } = vi.hoisted(() => ({ cancelOpenInvoiceCharges: vi.fn() }));
vi.mock("@/lib/billing/invoices.server", () => ({ cancelOpenInvoiceCharges }));

import { createFakeDb } from "./sms-bulk.test-support";
import { updateTenantSettingsFor } from "./tenants.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const INVOICE = "00000000-0000-4000-8000-00000000c0c0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";

type Ctx = Parameters<typeof updateTenantSettingsFor>[0];
const ctxFor = (userId: string) => ({ userId, supabase: fake.admin.client }) as unknown as Ctx;

function update(plano: "starter" | "pro" | "enterprise" | "interno") {
  return updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
    tenantId: TENANT,
    nome: "Casa",
    status: "active",
    plano,
    crm_model: "CRM_PLATAFORMA",
    planReason: "Virou parceiro interno",
  });
}

beforeEach(() => {
  fake.admin.reset();
  const tenant: Record<string, unknown> = {
    id: TENANT,
    nome: "Casa",
    slug: "casa",
    status: "active",
    plano: "starter",
    crm_model: "CRM_PLATAFORMA",
  };
  fake.admin.rows("tenants").push(tenant);
  // Stands in for the plano trigger: the open invoice is canceled as soon as
  // the house is on the exempt plan.
  fake.admin.rows("billing_invoices").push({
    id: INVOICE,
    tenant_id: TENANT,
    get status() {
      return tenant.plano === "interno" ? "canceled" : "open";
    },
  });
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  cancelOpenInvoiceCharges.mockReset().mockResolvedValue({ canceled: 1, failed: [] });
});

describe("updateTenantSettingsFor — house becomes exempt", () => {
  it("cancels the closed invoice's Pix at Upper and records it in the audit", async () => {
    await update("interno");
    expect(cancelOpenInvoiceCharges).toHaveBeenCalledWith(INVOICE);
    const audit = fake.admin.rows("tenant_audit_logs")[0];
    expect(audit.metadata).toMatchObject({
      pix_cancel: { invoiceId: INVOICE, ok: true, canceled: 1 },
    });
  });

  it("does not cancel anything when the invoice stays open (paying -> paying)", async () => {
    await update("pro");
    expect(cancelOpenInvoiceCharges).not.toHaveBeenCalled();
  });

  it("still saves the plan when the Upper cancel fails", async () => {
    cancelOpenInvoiceCharges.mockRejectedValueOnce(new Error("upper down"));
    const result = await update("interno");
    expect(result.tenant).toMatchObject({ plano: "interno" });
    const audit = fake.admin.rows("tenant_audit_logs")[0];
    expect(audit.metadata).toMatchObject({ pix_cancel: { ok: false } });
  });

  it("does nothing when there was no open invoice", async () => {
    fake.admin.rows("billing_invoices").length = 0;
    await update("interno");
    expect(cancelOpenInvoiceCharges).not.toHaveBeenCalled();
  });
});
