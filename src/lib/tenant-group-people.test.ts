// Grupos de casas, Task 4: a group manager may manage people (including
// admins) in the houses of their groups, and only there. It must not gain
// operational access: getTenantManagementConsole and updateTenantSettings
// keep requiring a role in the house (or super admin).

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});
import { createFakeDb } from "./sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import {
  addUserToTenantFor,
  getTenantManagementConsoleFor,
  getTenantSwitcherFor,
  removeUserFromTenantFor,
  updateTenantSettingsFor,
  updateTenantUserRoleFor,
} from "./tenants.functions";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const GROUP_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000cc";
const NEWCOMER = "00000000-0000-4000-8000-0000000000dd";
const SECOND_ADMIN = "00000000-0000-4000-8000-0000000000ee";
const GROUP_A = "00000000-0000-4000-8000-00000000a001";
const GROUP_Z = "00000000-0000-4000-8000-00000000f001";
const IN_GROUP = "00000000-0000-4000-8000-000000000101";
const OUTSIDE = "00000000-0000-4000-8000-000000000102";

const authUsers = [
  { id: SUPER, email: "super@example.com" },
  { id: GROUP_MANAGER, email: "gestor.grupo@example.com" },
  { id: HOUSE_ADMIN, email: "admin.casa@example.com" },
  { id: NEWCOMER, email: "novo@example.com" },
  { id: SECOND_ADMIN, email: "segundo.admin@example.com" },
];

type Ctx = Parameters<typeof addUserToTenantFor>[0];
const ctxFor = (userId: string, activeTenantId: string | null = null) =>
  ({ userId, supabase: fake.admin.client, activeTenantId }) as unknown as Ctx;

// Calls a `*For(ctx, data)` body as `userId`; inputs are already-parsed shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (fn: (ctx: Ctx, data: any) => Promise<unknown>, userId: string, data: unknown) =>
  fn(ctxFor(userId), data);

let groupManagerTenants: Set<string>;

beforeEach(() => {
  __resetDemoTenantCacheForTests();
  fake.admin.reset();
  groupManagerTenants = new Set([IN_GROUP]);
  (fake.admin.client as unknown as Record<string, unknown>).auth = {
    admin: {
      listUsers: async () => ({ data: { users: authUsers }, error: null }),
    },
  };
  fake.admin.onRpc("is_super_admin", (args) => ({ data: args._user_id === SUPER, error: null }));
  fake.admin.onRpc("is_group_manager_of_tenant", (args) => ({
    data: args._user === GROUP_MANAGER && groupManagerTenants.has(String(args._tenant)),
    error: null,
  }));
  fake.admin
    .rows("tenants")
    .push(
      { id: IN_GROUP, nome: "Casa do Grupo", slug: "grupo", status: "active", is_demo: false },
      { id: OUTSIDE, nome: "Casa de Fora", slug: "fora", status: "active", is_demo: false },
    );
  fake.admin
    .rows("user_roles")
    .push(
      {
        id: "role-admin-in",
        user_id: HOUSE_ADMIN,
        tenant_id: IN_GROUP,
        role: "admin",
        created_at: "1",
      },
      {
        id: "role-admin-out",
        user_id: HOUSE_ADMIN,
        tenant_id: OUTSIDE,
        role: "admin",
        created_at: "1",
      },
    );
});

describe("group manager people rights (tenants.functions.ts)", () => {
  it("group manager can add an admin to a house of the group", async () => {
    await expect(
      addUserToTenantFor(ctxFor(GROUP_MANAGER), {
        tenantId: IN_GROUP,
        email: "novo@example.com",
        role: "admin",
        password: null,
      }),
    ).resolves.toMatchObject({ ok: true, existing: false });
    expect(fake.admin.rows("user_roles")).toContainEqual(
      expect.objectContaining({ user_id: NEWCOMER, tenant_id: IN_GROUP, role: "admin" }),
    );
    expect(fake.admin.rows("tenant_audit_logs")).toContainEqual(
      expect.objectContaining({
        tenant_id: IN_GROUP,
        actor_user_id: GROUP_MANAGER,
        action: "tenant_user.added",
      }),
    );
  });

  it("group manager cannot manage a house outside the group", async () => {
    await expect(
      addUserToTenantFor(ctxFor(GROUP_MANAGER), {
        tenantId: OUTSIDE,
        email: "novo@example.com",
        role: "gestor",
        password: null,
      }),
    ).rejects.toThrow(/Sem permissão/);
    await expect(
      call(updateTenantUserRoleFor, GROUP_MANAGER, {
        tenantId: OUTSIDE,
        membershipId: "role-admin-out",
        role: "gestor",
      }),
    ).rejects.toThrow(/Sem permissão/);
    await expect(
      call(removeUserFromTenantFor, GROUP_MANAGER, {
        tenantId: OUTSIDE,
        membershipId: "role-admin-out",
      }),
    ).rejects.toThrow(/Sem permissão/);
    expect(fake.admin.rows("user_roles").filter((r) => r.tenant_id === OUTSIDE)).toHaveLength(1);
  });

  it("house admin still cannot set admin and still can add gestor", async () => {
    groupManagerTenants = new Set();
    await expect(
      addUserToTenantFor(ctxFor(HOUSE_ADMIN), {
        tenantId: IN_GROUP,
        email: "novo@example.com",
        role: "admin",
        password: null,
      }),
    ).rejects.toThrow("Apenas o super admin ou o gestor do grupo pode definir o admin da casa");
    await expect(
      addUserToTenantFor(ctxFor(HOUSE_ADMIN), {
        tenantId: IN_GROUP,
        email: "novo@example.com",
        role: "gestor",
        password: null,
      }),
    ).resolves.toMatchObject({ ok: true, existing: false });
    expect(fake.admin.rows("user_roles")).toContainEqual(
      expect.objectContaining({ user_id: NEWCOMER, tenant_id: IN_GROUP, role: "gestor" }),
    );
  });

  it("house admin cannot demote another admin through addUserToTenant", async () => {
    fake.admin.rows("user_roles").push({
      id: "role-second",
      user_id: SECOND_ADMIN,
      tenant_id: IN_GROUP,
      role: "admin",
      created_at: "2",
    });
    await expect(
      addUserToTenantFor(ctxFor(HOUSE_ADMIN), {
        tenantId: IN_GROUP,
        email: "segundo.admin@example.com",
        role: "gestor",
        password: null,
      }),
    ).rejects.toThrow("Apenas o super admin ou o gestor do grupo pode alterar o admin da casa");
    expect(fake.admin.rows("user_roles").find((r) => r.id === "role-second")?.role).toBe("admin");
  });

  it("group manager can promote, demote and remove admins in a group house", async () => {
    fake.admin.rows("user_roles").push({
      id: "role-second",
      user_id: SECOND_ADMIN,
      tenant_id: IN_GROUP,
      role: "admin",
      created_at: "2",
    });
    const roleOf = (id: string) => fake.admin.rows("user_roles").find((r) => r.id === id)?.role;

    await call(updateTenantUserRoleFor, GROUP_MANAGER, {
      tenantId: IN_GROUP,
      membershipId: "role-admin-in",
      role: "gestor",
    });
    expect(roleOf("role-admin-in")).toBe("gestor");

    await call(updateTenantUserRoleFor, GROUP_MANAGER, {
      tenantId: IN_GROUP,
      membershipId: "role-admin-in",
      role: "admin",
    });
    expect(roleOf("role-admin-in")).toBe("admin");

    await call(removeUserFromTenantFor, GROUP_MANAGER, {
      tenantId: IN_GROUP,
      membershipId: "role-second",
    });
    expect(roleOf("role-second")).toBeUndefined();
    expect(
      fake.admin
        .rows("tenant_audit_logs")
        .filter((row) => row.actor_user_id === GROUP_MANAGER)
        .map((row) => row.action),
    ).toEqual(["tenant_user.role_changed", "tenant_user.role_changed", "tenant_user.removed"]);
  });

  it("group manager still cannot remove or demote the only admin", async () => {
    fake.admin.rows("user_roles").push({
      id: "role-gestor",
      user_id: NEWCOMER,
      tenant_id: IN_GROUP,
      role: "gestor",
      created_at: "2",
    });
    await expect(
      call(updateTenantUserRoleFor, GROUP_MANAGER, {
        tenantId: IN_GROUP,
        membershipId: "role-admin-in",
        role: "member",
      }),
    ).rejects.toThrow("Nao e permitido remover o unico admin do tenant");
    await expect(
      call(removeUserFromTenantFor, GROUP_MANAGER, {
        tenantId: IN_GROUP,
        membershipId: "role-admin-in",
      }),
    ).rejects.toThrow("Nao e permitido remover o unico admin do tenant");
  });

  it("group manager cannot link a super admin", async () => {
    await expect(
      addUserToTenantFor(ctxFor(GROUP_MANAGER), {
        tenantId: IN_GROUP,
        email: "super@example.com",
        role: "admin",
        password: null,
      }),
    ).rejects.toThrow("Não é permitido vincular um superadmin global por esta área");
  });

  it("group manager on a demo house is still blocked by the demo guard", async () => {
    fake.admin.rows("tenants").find((t) => t.id === IN_GROUP)!.is_demo = true;
    await expect(
      addUserToTenantFor(ctxFor(GROUP_MANAGER), {
        tenantId: IN_GROUP,
        email: "novo@example.com",
        role: "gestor",
        password: null,
      }),
    ).rejects.toMatchObject({ code: "DEMO_ACTION_BLOCKED" });
  });
});

describe("group manager gains no operational access", () => {
  it("group manager without house role is still denied by getTenantManagementConsole", async () => {
    await expect(
      call(getTenantManagementConsoleFor, GROUP_MANAGER, { tenantId: IN_GROUP }),
    ).rejects.toThrow("Tenant sem acesso");
    await expect(call(getTenantManagementConsoleFor, GROUP_MANAGER, {})).resolves.toMatchObject({
      tenants: [],
      selectedTenantId: null,
      detail: null,
    });
  });

  it("group manager cannot change house settings", async () => {
    await expect(
      call(updateTenantSettingsFor, GROUP_MANAGER, {
        tenantId: IN_GROUP,
        nome: "Renomeada",
        status: "active",
        plano: "pro",
        crm_model: "CRM_PLATAFORMA",
      }),
    ).rejects.toThrow(/Sem permissão/);
    expect(fake.admin.rows("tenants").find((t) => t.id === IN_GROUP)?.nome).toBe("Casa do Grupo");
  });
});

describe("getTenantSwitcherFor — groups and can_view_finance", () => {
  it("switcher returns groups and can_view_finance", async () => {
    fake.admin
      .rows("tenant_groups")
      .push(
        { id: GROUP_Z, nome: "Zeta", is_demo: false },
        { id: GROUP_A, nome: "Alfa", is_demo: true },
        { id: "00000000-0000-4000-8000-00000000c001", nome: "Não gerido", is_demo: false },
      );
    fake.admin
      .rows("user_roles")
      .push({
        id: "role-gm",
        user_id: GROUP_MANAGER,
        tenant_id: OUTSIDE,
        role: "gestor",
        created_at: "3",
      });
    fake.admin.onRpc("group_ids_managed_by", (args) => ({
      data: args._user === GROUP_MANAGER ? [GROUP_Z, GROUP_A] : [],
      error: null,
    }));
    const financeCalls: unknown[] = [];
    fake.admin.onRpc("finance_can_view", (args) => {
      financeCalls.push(args);
      return { data: args._tenant === OUTSIDE, error: null };
    });

    const result = await getTenantSwitcherFor(ctxFor(GROUP_MANAGER));

    expect(result.tenants).toEqual([
      expect.objectContaining({ id: OUTSIDE, role: "gestor", can_view_finance: true }),
    ]);
    expect(result.groups).toEqual([
      { id: GROUP_A, nome: "Alfa", is_demo: true },
      { id: GROUP_Z, nome: "Zeta", is_demo: false },
    ]);
    expect(result.activeTenantId).toBe(OUTSIDE);
    expect(financeCalls).toEqual([{ _user: GROUP_MANAGER, _tenant: OUTSIDE }]);
  });

  it("group manager with no house role sees only groups", async () => {
    fake.admin.rows("tenant_groups").push({ id: GROUP_A, nome: "Alfa", is_demo: false });
    fake.admin.onRpc("group_ids_managed_by", () => ({ data: [GROUP_A], error: null }));
    fake.admin.onRpc("finance_can_view", () => ({ data: true, error: null }));

    const result = await getTenantSwitcherFor(ctxFor(GROUP_MANAGER));

    expect(result).toEqual({
      activeTenantId: null,
      tenants: [],
      groups: [{ id: GROUP_A, nome: "Alfa", is_demo: false }],
    });
  });

  it("degrades gracefully when the finance and group RPCs fail", async () => {
    fake.admin
      .rows("user_roles")
      .push({ id: "role-gm", user_id: GROUP_MANAGER, tenant_id: OUTSIDE, role: "gestor", created_at: "3" });
    fake.admin.onRpc("group_ids_managed_by", () => ({ data: null, error: { message: "boom" } }));
    fake.admin.onRpc("finance_can_view", () => ({ data: null, error: { message: "boom" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getTenantSwitcherFor(ctxFor(GROUP_MANAGER));

    expect(result.tenants).toEqual([
      expect.objectContaining({ id: OUTSIDE, can_view_finance: false }),
    ]);
    expect(result.groups).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("super admin can view every house's finance without a per-house RPC", async () => {
    fake.admin.onRpc("group_ids_managed_by", () => ({ data: [], error: null }));
    const financeCalls: unknown[] = [];
    fake.admin.onRpc("finance_can_view", (args) => {
      financeCalls.push(args);
      return { data: false, error: null };
    });

    const result = await getTenantSwitcherFor(ctxFor(SUPER));

    expect(result.tenants.map((t) => [t.id, t.can_view_finance]).sort()).toEqual(
      [
        [IN_GROUP, true],
        [OUTSIDE, true],
      ].sort(),
    );
    expect(financeCalls).toEqual([]);
  });
});
