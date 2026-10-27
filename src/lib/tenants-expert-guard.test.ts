// Área do Expert — Fase 1, Task 6: a tela Equipe não mexe em experts. O
// acesso de um expert é gerenciado só em Experts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
  authUsers: [] as Array<{ id: string; email: string }>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      auth: {
        admin: {
          listUsers: async () => ({ data: { users: fake.authUsers }, error: null }),
          inviteUserByEmail: async () => {
            throw new Error("unexpected invite");
          },
        },
      },
    },
  };
});

vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantNotDemo: vi.fn(async () => {}),
  isBillingEnforcementEnabled: () => false,
}));

import { createFakeDb } from "./sms-bulk.test-support";
import {
  addUserToTenantFor,
  getTenantManagementConsoleFor,
  getTenantSwitcherFor,
  removeUserFromTenantFor,
  updateTenantUserRoleFor,
} from "./tenants.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const EXPERT_USER = "00000000-0000-4000-8000-0000000000e1";
const EXPERT_MEMBERSHIP = "00000000-0000-4000-8000-0000000000f1";
const GUARD = "Esta pessoa é expert desta casa. Gerencie o acesso dela em Experts.";

type Ctx = Parameters<typeof addUserToTenantFor>[0];
const ctx = { userId: ADMIN, supabase: {} } as unknown as Ctx;

beforeEach(() => {
  fake.admin.reset();
  fake.authUsers.length = 0;
  fake.authUsers.push({ id: EXPERT_USER, email: "expert@casa.com" });
  fake.admin.onRpc("is_super_admin", () => ({ data: false, error: null }));
  fake.admin.onRpc("is_group_manager_of_tenant", () => ({ data: false, error: null }));
  fake.admin
    .rows("user_roles")
    .push(
      { id: "admin-membership", user_id: ADMIN, tenant_id: TENANT, role: "admin" },
      { id: EXPERT_MEMBERSHIP, user_id: EXPERT_USER, tenant_id: TENANT, role: "expert" },
    );
});

describe("team management refuses expert members", () => {
  it("team role change refuses an expert member", async () => {
    await expect(
      updateTenantUserRoleFor(ctx, {
        tenantId: TENANT,
        membershipId: EXPERT_MEMBERSHIP,
        role: "member",
      }),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")[1].role).toBe("expert");
  });

  it("team removal refuses an expert member", async () => {
    await expect(
      removeUserFromTenantFor(ctx, { tenantId: TENANT, membershipId: EXPERT_MEMBERSHIP }),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")).toHaveLength(2);
  });

  it("adding an existing expert as member is refused", async () => {
    await expect(
      addUserToTenantFor(ctx, { tenantId: TENANT, email: "expert@casa.com", role: "member" }),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")[1].role).toBe("expert");
  });

  it("a group manager of the house cannot bypass the expert guard either", async () => {
    const managerCtx = {
      userId: "00000000-0000-4000-8000-0000000000c1",
      supabase: {},
    } as unknown as Ctx;
    fake.admin.onRpc("is_group_manager_of_tenant", () => ({ data: true, error: null }));
    await expect(
      updateTenantUserRoleFor(managerCtx, {
        tenantId: TENANT,
        membershipId: EXPERT_MEMBERSHIP,
        role: "admin",
      }),
    ).rejects.toThrow(GUARD);
    await expect(
      removeUserFromTenantFor(managerCtx, { tenantId: TENANT, membershipId: EXPERT_MEMBERSHIP }),
    ).rejects.toThrow(GUARD);
    await expect(
      addUserToTenantFor(managerCtx, { tenantId: TENANT, email: "expert@casa.com", role: "admin" }),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")).toHaveLength(2);
    expect(fake.admin.rows("user_roles")[1].role).toBe("expert");
  });
});

describe("an expert is not a house member for the house console", () => {
  const expertCtx = { userId: EXPERT_USER, supabase: {} } as unknown as Ctx;

  beforeEach(() => {
    fake.admin.rows("tenants").push({
      id: TENANT,
      nome: "Casa A",
      slug: "casa-a",
      status: "active",
      plano: "pro",
      crm_model: "CRM_PLATAFORMA",
      limits: {},
      metadata: {},
      created_at: "2026-10-01T00:00:00Z",
      updated_at: null,
      is_demo: false,
    });
  });

  it("does not list the expert's house in the console (getAccessibleTenants)", async () => {
    const result = await getTenantManagementConsoleFor(expertCtx, { tenantId: null });
    expect(result.tenants).toEqual([]);
    expect(result.selectedTenantId).toBeNull();
    expect(result.detail).toBeNull();
  });

  it("refuses the console detail of the expert's own house", async () => {
    await expect(getTenantManagementConsoleFor(expertCtx, { tenantId: TENANT })).rejects.toThrow(
      "Tenant sem acesso",
    );
  });

  it("still lists the house in the switcher with role expert", async () => {
    const result = await getTenantSwitcherFor(expertCtx);
    expect(result.tenants).toEqual([expect.objectContaining({ id: TENANT, role: "expert" })]);
  });

  it("the console still works for a team admin of the same house", async () => {
    fake.admin.onRpc("wallet_summary", () => ({ data: { balance: 0 }, error: null }));
    const result = await getTenantManagementConsoleFor(ctx, { tenantId: null });
    expect(result.tenants.map((t) => t.id)).toEqual([TENANT]);
  });
});
