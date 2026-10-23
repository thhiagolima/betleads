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
  fake.admin.rows("user_roles").push(
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
});
