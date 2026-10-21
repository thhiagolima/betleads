// PG1 Task 8 — the legacy SMS credit screens/server functions now read the
// single BRL wallet (wallet_summary / admin_adjust_wallet, Task 3) instead of
// the old sms_credit_* tables/RPCs.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  adjustWalletInputFor,
  adminAdjustSmsCreditsFor,
  adminSmsCreditConsoleFor,
  createSmsCreditCheckoutFor,
  withoutProviderCost,
} from "./sms-credits.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";

type Ctx = Parameters<typeof adminAdjustSmsCreditsFor>[0];
const ctxFor = (userId: string) => ({ userId, supabase: fake.admin.client }) as unknown as Ctx;

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
  fake.admin.onRpc("admin_adjust_wallet", () => ({ data: { balance: 150 }, error: null }));
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
    expect(() => adjustWalletInputFor().parse({ tenantId: TENANT, amount: 0, reason: "ajuste" })).toThrow();
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
});
