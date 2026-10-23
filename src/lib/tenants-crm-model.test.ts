// Área do Expert — Fase 1, Task 3: CRM_EXPERT foi descontinuado.
// `updateTenantSettingsFor` recusa mudar uma casa *para* CRM_EXPERT, mas
// permite manter o valor já vigente (casas legadas continuam existindo).
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

describe("updateTenantSettingsFor — CRM_EXPERT descontinuado", () => {
  it("refuses switching a house to CRM_EXPERT", async () => {
    await expect(
      updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
        tenantId: TENANT,
        nome: "Casa",
        status: "active",
        plano: "starter",
        crm_model: "CRM_EXPERT",
      }),
    ).rejects.toThrow(
      "O modelo CRM Expert foi descontinuado. Cadastre experts dentro da casa, em Experts.",
    );
  });

  it("keeps CRM_EXPERT when it is already the current model", async () => {
    fake.admin.rows("tenants")[0].crm_model = "CRM_EXPERT";
    const result = await updateTenantSettingsFor(ctxFor(SUPER_ADMIN), {
      tenantId: TENANT,
      nome: "Casa",
      status: "active",
      plano: "starter",
      crm_model: "CRM_EXPERT",
    });
    expect(result.tenant).toMatchObject({ crm_model: "CRM_EXPERT" });
  });
});
