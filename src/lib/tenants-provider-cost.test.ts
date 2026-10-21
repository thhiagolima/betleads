// F-14 — the tenant detail must never ship the SMS supplier cost
// (`provider_unit_cost`) to anyone but the super admin. Since PG1 Task 8 it
// comes both from `wallet_summary.prices.sms` and from the flat
// `billing_effective_price`-shaped before/after of a price-override audit
// row; both are checked here against a mocked Supabase client.

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

const WALLET_SUMMARY = {
  balance: 100,
  lifetime_purchased: 200,
  lifetime_used: 100,
  exempt: false,
  month_usage: [],
  prices: {
    sms: { item: "sms", unit_price: 0.08, provider_unit_cost: 0.059, free_monthly_units: 0, source: "default" },
    voice_30s: { item: "voice_30s", unit_price: 0.09, free_monthly_units: 0, source: "default" },
    email: { item: "email", unit_price: 0.002, free_monthly_units: 100000, source: "default" },
  },
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
  // What adminSetTenantPrice / adminAdjustSmsCredits write for the house.
  fake.admin.rows("tenant_audit_logs").push({
    id: "audit-1",
    tenant_id: TENANT,
    actor_user_id: SUPER_ADMIN_USER,
    action: "tenant_wallet.adjusted",
    entity_type: "tenant_wallet",
    entity_id: TENANT,
    before_data: { ...WALLET_SUMMARY },
    after_data: { ...WALLET_SUMMARY, balance: 150 },
    metadata: { amount: 50, reason: "ajuste" },
    created_at: "2026-10-02T00:00:00Z",
  });
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN_USER,
    error: null,
  }));
  fake.admin.onRpc("wallet_summary", () => ({ data: { ...WALLET_SUMMARY }, error: null }));
});

describe("getTenantManagementConsoleFor — supplier cost", () => {
  it("strips provider_unit_cost from prices.* for a tenant admin who is not super admin", async () => {
    const result = await getTenantManagementConsoleFor(ctxFor(TENANT_ADMIN_USER), {
      tenantId: TENANT,
    });

    expect(result.isSuperAdmin).toBe(false);
    const sms = result.detail!.sms;
    expect(sms.summary).not.toHaveProperty("prices.sms.provider_unit_cost");
    const prices = (sms.summary as Record<string, unknown>).prices as Record<string, unknown>;
    expect(prices.sms).not.toHaveProperty("provider_unit_cost");
    expect(prices.sms).toMatchObject({ unit_price: 0.08 });
    expect(sms.pricing).not.toHaveProperty("provider_unit_cost");
    expect(sms.pricing).toMatchObject({ unit_price: 0.08 });
    // Includes the audit trail: before/after/metadata of wallet changes.
    expect(result.detail!.audit).toHaveLength(1);
    expect(result.detail!.audit[0]).toMatchObject({ metadata: { reason: "ajuste" } });
    expect(JSON.stringify(result)).not.toContain("provider_unit_cost");
  });

  it("keeps provider_unit_cost for the super admin", async () => {
    const result = await getTenantManagementConsoleFor(ctxFor(SUPER_ADMIN_USER), {
      tenantId: TENANT,
    });

    expect(result.isSuperAdmin).toBe(true);
    expect(result.detail!.sms.pricing).toMatchObject({ provider_unit_cost: 0.059 });
    expect(JSON.stringify(result.detail!.audit)).toContain("provider_unit_cost");
  });
});
