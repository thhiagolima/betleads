// PG1 Task 8 — the legacy SMS credit screens/server functions now read the
// single BRL wallet (wallet_summary / admin_adjust_wallet, Task 3) instead of
// the old sms_credit_* tables/RPCs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("@/lib/tenant-access.server", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tenant-access.server")>(
      "@/lib/tenant-access.server",
    );
  return {
    ...actual,
    assertTenantNotDemo: vi.fn(async () => {}),
    assertTenantCanOpenBilling: vi.fn(async () => {}),
    listDemoTenantIds: vi.fn(async () => []),
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import {
  adjustWalletInput,
  adminAdjustSmsCreditsFor,
  adminSmsCreditConsoleFor,
  createSmsCreditCheckoutFor,
  currentOverrideItemsByTenant,
  getSmsCreditPortalFor,
  withoutProviderCost,
} from "./sms-credits.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";
const HOUSE_GESTOR = "00000000-0000-4000-8000-0000000000bc";
const HOUSE_MEMBER = "00000000-0000-4000-8000-0000000000bd";

type Ctx = Parameters<typeof adminAdjustSmsCreditsFor>[0];

/**
 * `admin_adjust_wallet` checks `is_super_admin()` with no service_role
 * bypass: calling it through `supabaseAdmin` (auth.uid() is null there)
 * always fails with `forbidden`, even for a real super admin. The
 * `supabaseAdmin` fake (`fake.admin`) below registers `admin_adjust_wallet`
 * to fail exactly that way, so a test that still passes a context whose
 * `supabase` is `fake.admin.client` would catch a regression back to the
 * bug; `ctxFor` below instead wires `supabase` to a separate `userDb` fake
 * that registers a real, succeeding handler — proving the code calls the
 * caller's own client, not `supabaseAdmin`.
 */
let userDb: ReturnType<typeof createFakeDb>;
const ctxFor = (userId: string) => ({ userId, supabase: userDb.client }) as unknown as Ctx;

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin.onRpc("wallet_summary", () => ({
    data: { balance: 100, lifetime_purchased: 200, lifetime_used: 100, exempt: false },
    error: null,
  }));
  fake.admin.onRpc("admin_adjust_wallet", () => ({
    data: null,
    error: { message: "forbidden" },
  }));

  userDb = createFakeDb();
  userDb.onRpc("admin_adjust_wallet", () => ({ data: { balance: 150 }, error: null }));
});

describe("withoutProviderCost", () => {
  it("drops provider_unit_cost from each item in prices, keeps the rest", () => {
    const out = withoutProviderCost({
      balance: 10,
      prices: {
        sms: { unit_price: 0.08, provider_unit_cost: 0.059 },
        voice_30s: { unit_price: 0.09 },
      },
    });
    expect(out).toEqual({
      balance: 10,
      prices: {
        sms: { unit_price: 0.08 },
        voice_30s: { unit_price: 0.09 },
      },
    });
    expect(JSON.stringify(out)).not.toContain("provider_unit_cost");
  });

  it("handles a missing summary or prices", () => {
    expect(withoutProviderCost(null)).toEqual({});
    expect(withoutProviderCost({ balance: 1 })).toEqual({ balance: 1 });
  });
});

describe("adminAdjustSmsCreditsFor", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      adminAdjustSmsCreditsFor(ctxFor(HOUSE_ADMIN), {
        tenantId: TENANT,
        amount: 50,
        reason: "ajuste",
      }),
    ).rejects.toThrow(/super admin/i);
  });

  it("fails validation when amount is 0", () => {
    expect(() =>
      adjustWalletInput.parse({ tenantId: TENANT, amount: 0, reason: "ajuste" }),
    ).toThrow();
  });

  it("calls admin_adjust_wallet through the caller's own client, not supabaseAdmin", async () => {
    // Regression guard for the `forbidden` bug: if the code called
    // `supabaseAdmin.rpc("admin_adjust_wallet", ...)` instead of
    // `ctx.supabase`, this would reject (see the `supabaseAdmin` fake's
    // handler in beforeEach).
    const result = await adminAdjustSmsCreditsFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      amount: 50,
      reason: "ajuste manual",
    });
    expect(result).toEqual({ ok: true });
  });

  it("calls admin_adjust_wallet with the R$ amount and audits before/after", async () => {
    const result = await adminAdjustSmsCreditsFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      amount: 50,
      reason: "ajuste manual",
    });
    expect(result).toEqual({ ok: true });
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant_wallet.adjusted",
      metadata: { amount: 50, reason: "ajuste manual" },
    });
  });
});

describe("getSmsCreditPortalFor canBuy", () => {
  beforeEach(() => {
    __resetDemoTenantCacheForTests();
    userDb.onRpc("is_super_admin", () => ({ data: false, error: null }));
    userDb.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
    userDb.onRpc("is_tenant_admin", (args) => ({
      data: args._tenant === TENANT,
      error: null,
    }));
    userDb.onRpc("wallet_summary", () => ({
      data: { balance: 100, lifetime_purchased: 200, lifetime_used: 100, exempt: false },
      error: null,
    }));
    userDb.rows("user_roles").push(
      { user_id: HOUSE_ADMIN, tenant_id: TENANT, role: "admin" },
      { user_id: HOUSE_GESTOR, tenant_id: TENANT, role: "gestor" },
      { user_id: HOUSE_MEMBER, tenant_id: TENANT, role: "member" },
    );
  });

  afterEach(() => {
    delete process.env.BILLING_GATEWAY_ENABLED;
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_INVOICES_ENABLED;
  });

  it("is false when the gateway is off, even for an admin of a paying house", async () => {
    delete process.env.BILLING_GATEWAY_ENABLED;
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_ADMIN), { tenantId: null });
    expect(result.canBuy).toBe(false);
  });

  it("is true for a gestor of a paying house, gateway on (gestor can pay)", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "true";
    userDb.onRpc("is_tenant_admin", () => ({ data: false, error: null }));
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_GESTOR), { tenantId: null });
    expect(result.canBuy).toBe(true);
  });

  it("is false for a member of a paying house, gateway on", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "true";
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_MEMBER), { tenantId: null });
    expect(result.canBuy).toBe(false);
  });

  it("is false (without throwing) for a house locked for the monthly fee, and the portal still loads", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "true";
    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    process.env.BILLING_INVOICES_ENABLED = "true";
    fake.admin.rows("tenants").push({
      id: TENANT,
      status: "active",
      is_demo: false,
      tenant_billing: { access_state: "locked_unpaid" },
    });
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_ADMIN), { tenantId: null });
    expect(result.tenantId).toBe(TENANT);
    expect(result.canBuy).toBe(false);
  });

  it("is false for an exempt house's admin, gateway on", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "true";
    userDb.onRpc("wallet_summary", () => ({
      data: { balance: 0, lifetime_purchased: 0, lifetime_used: 0, exempt: true },
      error: null,
    }));
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_ADMIN), { tenantId: null });
    expect(result.canBuy).toBe(false);
  });

  it("is true for the admin of a paying, non-demo house with the gateway on", async () => {
    process.env.BILLING_GATEWAY_ENABLED = "true";
    const result = await getSmsCreditPortalFor(ctxFor(HOUSE_ADMIN), { tenantId: null });
    expect(result.canBuy).toBe(true);
  });
});

describe("createSmsCreditCheckoutFor", () => {
  it("throws the 'coming in PG2' message for a house user", async () => {
    await expect(createSmsCreditCheckoutFor(ctxFor(HOUSE_ADMIN), {})).rejects.toThrow(
      "Compra por Pix disponível em breve. Fale com o suporte para adicionar saldo.",
    );
  });
});

describe("adminSmsCreditConsoleFor", () => {
  it("lists tenant wallets (excluding demo) and keeps old orders read-only", async () => {
    fake.admin.rows("tenants").push(
      { id: TENANT, nome: "Casa Normal", slug: "normal", plano: "pro" },
      { id: "demo-tenant", nome: "Casa Demo", slug: "demo", plano: "starter" },
    );
    fake.admin.rows("tenant_wallets").push({
      tenant_id: TENANT,
      balance: 120.5,
      lifetime_purchased: 500,
      lifetime_used: 379.5,
    });
    fake.admin.onRpc("is_super_admin", (args) => ({
      data: args._user_id === SUPER_ADMIN,
      error: null,
    }));
    const result = await adminSmsCreditConsoleFor(ctxFor(SUPER_ADMIN) as never);
    expect(result.wallets.some((w) => w.tenant_id === TENANT)).toBe(true);
    expect(result.wallets.find((w) => w.tenant_id === TENANT)).toMatchObject({
      balance: 120.5,
    });
  });

  it("has_custom_pricing reflects the CURRENT override, not 'ever had one'", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Normal", slug: "normal", plano: "pro" });
    // An override was set, then cleared (the clear writes a newer row with
    // unit_price = null) — the badge must be OFF, not stuck on from the
    // first row.
    fake.admin.rows("tenant_price_overrides").push(
      { tenant_id: TENANT, item: "sms", unit_price: 0.07, valid_from: "2026-01-01T00:00:00Z" },
      { tenant_id: TENANT, item: "sms", unit_price: null, valid_from: "2026-02-01T00:00:00Z" },
    );
    const result = await adminSmsCreditConsoleFor(ctxFor(SUPER_ADMIN) as never);
    expect(result.wallets.find((w) => w.tenant_id === TENANT)).toMatchObject({
      has_custom_pricing: false,
    });
  });

  it("has_custom_pricing is ON when the latest row for an item is a live override", async () => {
    fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa Normal", slug: "normal", plano: "pro" });
    fake.admin.rows("tenant_price_overrides").push({
      tenant_id: TENANT,
      item: "email",
      unit_price: 0.003,
      valid_from: "2026-01-01T00:00:00Z",
    });
    const result = await adminSmsCreditConsoleFor(ctxFor(SUPER_ADMIN) as never);
    expect(result.wallets.find((w) => w.tenant_id === TENANT)).toMatchObject({
      has_custom_pricing: true,
    });
  });
});

describe("currentOverrideItemsByTenant", () => {
  it("ignores a future-dated row (not in effect yet)", () => {
    const result = currentOverrideItemsByTenant([
      { tenant_id: TENANT, item: "sms", unit_price: 0.07, valid_from: "2999-01-01T00:00:00Z" },
    ]);
    expect(result.get(TENANT)).toBeUndefined();
  });

  it("picks the latest-per-(tenant,item) row and drops null unit_price", () => {
    const result = currentOverrideItemsByTenant([
      { tenant_id: TENANT, item: "sms", unit_price: 0.07, valid_from: "2026-01-01T00:00:00Z" },
      { tenant_id: TENANT, item: "sms", unit_price: null, valid_from: "2026-02-01T00:00:00Z" },
      { tenant_id: TENANT, item: "email", unit_price: 0.003, valid_from: "2026-01-15T00:00:00Z" },
    ]);
    expect(result.get(TENANT)).toEqual(new Set(["email"]));
  });

  it("tracks multiple tenants independently", () => {
    const other = "00000000-0000-4000-8000-00000000c0c0";
    const result = currentOverrideItemsByTenant([
      { tenant_id: TENANT, item: "sms", unit_price: 0.07, valid_from: "2026-01-01T00:00:00Z" },
      { tenant_id: other, item: "voice_30s", unit_price: 0.1, valid_from: "2026-01-01T00:00:00Z" },
    ]);
    expect(result.get(TENANT)).toEqual(new Set(["sms"]));
    expect(result.get(other)).toEqual(new Set(["voice_30s"]));
  });
});
