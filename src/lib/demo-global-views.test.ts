// Task 10 — demo tenants excluded from platform-wide totals.
//
// `admin_platform_metrics` (src/lib/admin.functions.ts: adminPlatformMetrics)
// returns a single aggregated jsonb row, so it is fixed in SQL
// (supabase/migrations/20261018120000_demo_tenant_global_views.sql, exercised
// by demo-global-views.db.test.ts against a real PGlite instance) rather than
// filtered here — there is nothing for a TS-level mock to meaningfully
// exercise for that RPC.
//
// The other two "global" surfaces in scope DO return per-tenant rows, so they
// are filtered here, in TS, against a mocked Supabase client:
// - `adminSmsCreditConsoleFor` (src/lib/sms-credits.functions.ts): the
//   platform-wide "Saldos por tenant" / "Pedidos de créditos" lists.
// - `getTenantSwitcherFor` (src/lib/tenants.functions.ts): must keep the
//   demo tenant in the switcher (Task 11 decides what to do with it) but
//   annotate each tenant with `is_demo`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "./sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { adminSmsCreditConsoleFor } from "./sms-credits.functions";
import { getTenantSwitcherFor } from "./tenants.functions";

const NORMAL_TENANT = "00000000-0000-4000-8000-00000000a0a0";
const DEMO_TENANT = "00000000-0000-4000-8000-00000000d0d0";
const SUPER_ADMIN_USER = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  __resetDemoTenantCacheForTests();
  fake.admin.reset();
  fake.admin
    .rows("tenants")
    .push(
      {
        id: NORMAL_TENANT,
        nome: "Casa Normal",
        slug: "normal",
        status: "active",
        plano: "pro",
        is_demo: false,
      },
      {
        id: DEMO_TENANT,
        nome: "Casa Demo",
        slug: "demo",
        status: "active",
        plano: "pro",
        is_demo: true,
      },
    );
  fake.admin.onRpc("is_super_admin", () => ({ data: true, error: null }));
  // getTenantSwitcherFor also asks for finance visibility and managed groups.
  fake.admin.onRpc("finance_can_view", () => ({ data: true, error: null }));
  fake.admin.onRpc("group_ids_managed_by", () => ({ data: [], error: null }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adminSmsCreditConsoleFor — platform-wide SMS credit totals", () => {
  beforeEach(() => {
    fake.admin.onRpc("admin_sms_credit_overview", () => ({
      data: [
        { tenant_id: NORMAL_TENANT, tenant_name: "Casa Normal", balance_credits: 1000 },
        { tenant_id: DEMO_TENANT, tenant_name: "Casa Demo", balance_credits: 500 },
      ],
      error: null,
    }));
    fake.admin
      .rows("sms_credit_orders")
      .push(
        { id: "order-normal", tenant_id: NORMAL_TENANT, credits: 100, amount_cents: 1000 },
        { id: "order-demo", tenant_id: DEMO_TENANT, credits: 200, amount_cents: 2000 },
      );
  });

  it("sums/lists only the normal tenant's balance overview, excluding the demo tenant", async () => {
    const result = await adminSmsCreditConsoleFor({
      userId: SUPER_ADMIN_USER,
      supabase: fake.admin.client,
    } as unknown as Parameters<typeof adminSmsCreditConsoleFor>[0]);

    expect(result.overview.map((row) => row.tenant_id)).toEqual([NORMAL_TENANT]);
  });

  it("excludes the demo tenant's credit orders from the platform-wide orders list", async () => {
    const result = await adminSmsCreditConsoleFor({
      userId: SUPER_ADMIN_USER,
      supabase: fake.admin.client,
    } as unknown as Parameters<typeof adminSmsCreditConsoleFor>[0]);

    expect(result.orders.map((row) => row.tenant_id)).toEqual([NORMAL_TENANT]);
  });
});

describe("getTenantSwitcherFor — is_demo flag", () => {
  it("returns is_demo per tenant and keeps the demo tenant in the switcher", async () => {
    const result = await getTenantSwitcherFor({
      userId: SUPER_ADMIN_USER,
      supabase: fake.admin.client,
      activeTenantId: null,
    } as unknown as Parameters<typeof getTenantSwitcherFor>[0]);

    const byId = new Map(result.tenants.map((tenant) => [tenant.id, tenant]));
    expect(byId.get(NORMAL_TENANT)?.is_demo).toBe(false);
    expect(byId.get(DEMO_TENANT)?.is_demo).toBe(true);
    expect(byId.size).toBe(2);
  });
});
