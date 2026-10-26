// PG1 Task 8 — `updateTenantSettings` requires a `planReason` (>= 5 chars)
// whenever `plano` changes into or out of `'interno'`; the reason is written
// to `metadata.plan_reason` in the tenant audit log.
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

import { createFakeDb } from "./sms-bulk.test-support";
import { updateTenantSettingsFor } from "./tenants.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";

type Ctx = Parameters<typeof updateTenantSettingsFor>[0];
const ctxFor = (userId: string) => ({ userId, supabase: fake.admin.client }) as unknown as Ctx;

beforeEach(() => {
  fake.admin.reset();
  fake.admin.rows("tenants").push({
    id: TENANT,
    nome: "Casa",
    slug: "casa",
    status: "active",
    plano: "starter",
    crm_model: "CRM_PLATAFORMA",
  });
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
});

describe("updateTenantSettingsFor — plan reason", () => {
  it("rejects starter -> interno without a planReason", async () => {
    await expect(
      updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        nome: "Casa",
        status: "active",
        plano: "interno",
        crm_model: "CRM_PLATAFORMA",
      }),
    ).rejects.toThrow("Informe o motivo da troca de plano");
  });

  it("rejects a planReason shorter than 5 characters", async () => {
    await expect(
      updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        nome: "Casa",
        status: "active",
        plano: "interno",
        crm_model: "CRM_PLATAFORMA",
        planReason: "oi",
      }),
    ).rejects.toThrow("Informe o motivo da troca de plano");
  });

  it("accepts a >= 5 char reason and writes metadata.plan_reason to the audit log", async () => {
    const result = await updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      nome: "Casa",
      status: "active",
      plano: "interno",
      crm_model: "CRM_PLATAFORMA",
      planReason: "Virou parceiro interno",
    });
    expect(result.tenant).toMatchObject({ plano: "interno" });
    const audit = fake.admin.rows("tenant_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "tenant.updated",
      metadata: { plan_reason: "Virou parceiro interno" },
    });
  });

  it("does not require a reason when the change does not touch 'interno'", async () => {
    const result = await updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      nome: "Casa",
      status: "active",
      plano: "pro",
      crm_model: "CRM_PLATAFORMA",
    });
    expect(result.tenant).toMatchObject({ plano: "pro" });
  });

  it("rejects interno -> pro without a planReason too (either direction)", async () => {
    fake.admin.rows("tenants")[0].plano = "interno";
    await expect(
      updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        nome: "Casa",
        status: "active",
        plano: "pro",
        crm_model: "CRM_PLATAFORMA",
      }),
    ).rejects.toThrow("Informe o motivo da troca de plano");
  });
});
