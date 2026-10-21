// F-14 — the tenant detail must never ship the SMS supplier cost
// (`provider_cost_per_sms`) to anyone but the super admin. It comes both from
// `sms_effective_pricing` and nested in `sms_credit_summary.pricing`, so both
// are checked here against a mocked Supabase client.

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

import { createFakeDb } from "./sms-bulk.test-support";
import { getTenantManagementConsoleFor } from "./tenants.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN_USER = "00000000-0000-4000-8000-0000000000aa";
const TENANT_ADMIN_USER = "00000000-0000-4000-8000-0000000000bb";

const PRICING = {
  tenant_id: TENANT,
  sale_price_per_sms: 0.12,
  provider_cost_per_sms: 0.059,
  min_checkout_credits: 1000,
  low_balance_threshold: 500,
  has_tenant_override: false,
};

type Ctx = Parameters<typeof getTenantManagementConsoleFor>[0];
const ctxFor = (userId: string) => ({ userId, supabase: fake.admin.client }) as unknown as Ctx;

beforeEach(() => {
  fake.admin.reset();
  fake.admin.rows("tenants").push({
    id: TENANT,
    nome: "Casa Normal",
    slug: "normal",
    status: "active",
    plano: "pro",
    is_demo: false,
  });
  fake.admin.rows("user_roles").push({
    id: "role-1",
    user_id: TENANT_ADMIN_USER,
    tenant_id: TENANT,
    role: "admin",
    created_at: "2026-10-01T00:00:00Z",
  });
  // What adminSetTenantSmsPricing / adminAdjustSmsCredits write for the house.
  fake.admin.rows("tenant_audit_logs").push({
    id: "audit-1",
    tenant_id: TENANT,
    actor_user_id: SUPER_ADMIN_USER,
    action: "sms_pricing.set",
    entity_type: "tenant_sms_pricing",
    entity_id: TENANT,
    before_data: { ...PRICING },
    after_data: { balance_credits: 100, pricing: { ...PRICING } },
    metadata: { provider_cost_per_sms: 0.059, reason: "ajuste" },
    created_at: "2026-10-02T00:00:00Z",
  });
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN_USER,
    error: null,
  }));
  fake.admin.onRpc("sms_effective_pricing", () => ({ data: { ...PRICING }, error: null }));
  fake.admin.onRpc("sms_credit_summary", () => ({
    data: { tenant_id: TENANT, balance_credits: 100, pricing: { ...PRICING } },
    error: null,
  }));
});

describe("getTenantManagementConsoleFor — supplier SMS cost", () => {
  it("strips provider_cost_per_sms for a tenant admin who is not super admin", async () => {
    const result = await getTenantManagementConsoleFor(ctxFor(TENANT_ADMIN_USER), {
      tenantId: TENANT,
    });

    expect(result.isSuperAdmin).toBe(false);
    const sms = result.detail!.sms;
    expect(sms.pricing).not.toHaveProperty("provider_cost_per_sms");
    expect(sms.pricing).toMatchObject({ sale_price_per_sms: 0.12 });
    expect((sms.summary as Record<string, unknown>).pricing).not.toHaveProperty(
      "provider_cost_per_sms",
    );
    expect(sms.summary).toMatchObject({ balance_credits: 100 });
    // Includes the audit trail: before/after/metadata of pricing changes.
    expect(result.detail!.audit).toHaveLength(1);
    expect(result.detail!.audit[0]).toMatchObject({ metadata: { reason: "ajuste" } });
    expect(JSON.stringify(result)).not.toContain("provider_cost_per_sms");
  });

  it("keeps provider_cost_per_sms for the super admin", async () => {
    const result = await getTenantManagementConsoleFor(ctxFor(SUPER_ADMIN_USER), {
      tenantId: TENANT,
    });

    expect(result.isSuperAdmin).toBe(true);
    expect(result.detail!.sms.pricing).toMatchObject({ provider_cost_per_sms: 0.059 });
    expect(JSON.stringify(result.detail!.audit)).toContain("provider_cost_per_sms");
  });
});
