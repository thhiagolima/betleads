import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { adminClearTenantPriceFor, adminSetTenantPriceFor } from "./billing.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";

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
  fake.admin.onRpc("admin_set_tenant_price", (args) => ({
    data: {
      tenant_id: args._tenant,
      item: args._item,
      unit_price: args._unit_price,
      valid_from: new Date().toISOString(),
    },
    error: null,
  }));
  fake.admin.onRpc("admin_clear_tenant_price", (args) => ({
    data: {
      tenant_id: args._tenant,
      item: args._item,
      unit_price: null,
      valid_from: new Date().toISOString(),
    },
    error: null,
  }));
});

describe("adminSetTenantPriceFor — permission", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      adminSetTenantPriceFor(
        { userId: HOUSE_ADMIN },
        { tenantId: TENANT, item: "sms", unitPrice: 0.07 },
      ),
    ).rejects.toThrow(/super admin/i);
    expect(fake.admin.rows("tenant_audit_logs")).toHaveLength(0);
  });

  it("writes the override and an audit row (before/after) for the super admin", async () => {
    const result = await adminSetTenantPriceFor(
      { userId: SUPER_ADMIN },
      { tenantId: TENANT, item: "sms", unitPrice: 0.07 },
    );
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
      adminSetTenantPriceFor(
        { userId: SUPER_ADMIN },
        { tenantId: TENANT, item: "voice_30s", unitPrice: 0.1 },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      adminSetTenantPriceFor(
        { userId: SUPER_ADMIN },
        { tenantId: TENANT, item: "email", unitPrice: 0.003 },
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("adminClearTenantPriceFor — permission", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      adminClearTenantPriceFor({ userId: HOUSE_ADMIN }, { tenantId: TENANT, item: "sms" }),
    ).rejects.toThrow(/super admin/i);
  });

  it("clears the override and audits it for the super admin", async () => {
    const result = await adminClearTenantPriceFor(
      { userId: SUPER_ADMIN },
      { tenantId: TENANT, item: "sms" },
    );
    expect(result).toEqual({ ok: true });
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "tenant_price.cleared" });
  });
});
