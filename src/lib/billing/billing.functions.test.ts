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
  getTenantEffectivePriceFor,
} from "./billing.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";

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
