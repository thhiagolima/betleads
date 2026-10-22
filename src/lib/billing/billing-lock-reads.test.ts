// Mensalidade Task 4, fix round 1 — reads that used to call the raw
// `current_tenant_id` RPC now go through the billing-aware resolver: a
// non-superadmin of a locked house is refused with BILLING_LOCKED.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import { getGamificationDataFor } from "@/lib/gamification.functions";
import { resolveTenantReadFilter } from "@/lib/history.functions";
import { resolveSmsAudienceTenant } from "@/lib/sms-audience-crud.functions";
import { assertExternalIntegrationManager } from "@/lib/whatsapp-external.server";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000b1";

function userClient(userId: string) {
  const db = createFakeDb();
  db.onRpc("is_super_admin", (args) => ({
    data: ((args?._user_id as string | undefined) ?? userId) === SUPER_ADMIN,
    error: null,
  }));
  db.onRpc("current_tenant_id", () => ({ data: TENANT, error: null }));
  return db.client;
}

function setBillingState(state: string) {
  fake.admin.rows("tenants")[0].tenant_billing = { access_state: state };
  __resetDemoTenantCacheForTests();
}

beforeEach(() => {
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin.rows("tenants").push({
    id: TENANT,
    status: "active",
    is_demo: false,
    tenant_billing: { access_state: "locked_unpaid" },
  });
  fake.admin.rows("user_roles").push({ user_id: ADMIN, tenant_id: TENANT, role: "admin" });
  vi.stubEnv("BILLING_ENFORCEMENT_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reads behind the tenant resolver on a locked house", () => {
  it("getGamificationData refuses the house admin", async () => {
    await expect(getGamificationDataFor(userClient(ADMIN))).rejects.toMatchObject({
      code: "BILLING_LOCKED",
    });
  });

  it("the SMS audiences tenant refuses the admin; works again once the house is unlocked", async () => {
    await expect(resolveSmsAudienceTenant(userClient(ADMIN))).rejects.toMatchObject({
      code: "BILLING_LOCKED",
    });
    setBillingState("ok");
    await expect(resolveSmsAudienceTenant(userClient(ADMIN))).resolves.toBe(TENANT);
  });

  it("the SMS audiences tenant lets the superadmin through", async () => {
    await expect(resolveSmsAudienceTenant(userClient(SUPER_ADMIN))).resolves.toBe(TENANT);
  });

  it("history's tenant filter refuses the admin, keeps the superadmin unfiltered", async () => {
    await expect(resolveTenantReadFilter(userClient(ADMIN), ADMIN)).rejects.toMatchObject({
      code: "BILLING_LOCKED",
    });
    await expect(resolveTenantReadFilter(userClient(SUPER_ADMIN), SUPER_ADMIN)).resolves.toBeNull();
    setBillingState("overdue");
    await expect(resolveTenantReadFilter(userClient(ADMIN), ADMIN)).resolves.toBe(TENANT);
  });

  it("the external WhatsApp integration manager check refuses the admin, not the superadmin", async () => {
    await expect(
      assertExternalIntegrationManager(userClient(ADMIN) as never, ADMIN),
    ).rejects.toMatchObject({ code: "BILLING_LOCKED" });
    await expect(
      assertExternalIntegrationManager(userClient(SUPER_ADMIN) as never, SUPER_ADMIN),
    ).resolves.toBe(TENANT);
  });
});
