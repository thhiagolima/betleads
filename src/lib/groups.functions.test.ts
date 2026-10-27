// Grupos de casas, Task 4: super-admin group management (groups.functions.ts).
// Uses the in-memory createFakeDb stand-in for supabaseAdmin, with the SQL
// helpers (is_super_admin, group_ids_managed_by, finance_can_view) stubbed
// through onRpc.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb({ unique: { tenant_group_tenants: [["tenant_id"]] } });
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "./sms-bulk.test-support";
import {
  addGroupManagerFor,
  createGroupFor,
  deleteGroupFor,
  getGroupPeopleFor,
  listGroupsAdminFor,
  removeGroupManagerFor,
  renameGroupFor,
  setGroupTenantsFor,
} from "./groups.functions";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const MANAGER = "00000000-0000-4000-8000-0000000000bb";
const OTHER_SUPER = "00000000-0000-4000-8000-0000000000cc";
const PLAIN = "00000000-0000-4000-8000-0000000000dd";
const GROUP_A = "00000000-0000-4000-8000-00000000a001";
const GROUP_B = "00000000-0000-4000-8000-00000000b001";
const HOUSE_1 = "00000000-0000-4000-8000-000000000101";
const HOUSE_2 = "00000000-0000-4000-8000-000000000102";
const HOUSE_3 = "00000000-0000-4000-8000-000000000103";

const superAdmins = new Set([SUPER, OTHER_SUPER]);
const authUsers = [
  { id: SUPER, email: "super@example.com" },
  { id: MANAGER, email: "gestor.grupo@example.com" },
  { id: OTHER_SUPER, email: "outro.super@example.com" },
  { id: PLAIN, email: "plain@example.com" },
];

type Ctx = Parameters<typeof createGroupFor>[0];
const ctxFor = (userId: string) => ({ userId, supabase: fake.admin.client }) as unknown as Ctx;

beforeEach(() => {
  fake.admin.reset();
  (fake.admin.client as unknown as Record<string, unknown>).auth = {
    admin: {
      listUsers: async () => ({ data: { users: authUsers }, error: null }),
    },
  };
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: superAdmins.has(String(args._user_id)),
    error: null,
  }));
  fake.admin.onRpc("group_ids_managed_by", (args) => {
    if (superAdmins.has(String(args._user))) {
      return { data: fake.admin.rows("tenant_groups").map((g) => g.id), error: null };
    }
    return {
      data: fake.admin
        .rows("tenant_group_managers")
        .filter((m) => m.user_id === args._user)
        .map((m) => m.group_id),
      error: null,
    };
  });
  fake.admin.onRpc("finance_can_view", (args) => ({
    data: args._user === MANAGER || args._user === SUPER,
    error: null,
  }));
  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_1, nome: "Casa Um", slug: "um", status: "active", is_demo: false },
      { id: HOUSE_2, nome: "Casa Dois", slug: "dois", status: "active", is_demo: false },
      { id: HOUSE_3, nome: "Casa Três", slug: "tres", status: "active", is_demo: false },
    );
  fake.admin
    .rows("tenant_groups")
    .push(
      { id: GROUP_A, nome: "Grupo A", is_demo: false },
      { id: GROUP_B, nome: "Grupo B", is_demo: false },
    );
  fake.admin
    .rows("tenant_group_tenants")
    .push({ group_id: GROUP_A, tenant_id: HOUSE_1 }, { group_id: GROUP_B, tenant_id: HOUSE_2 });
  fake.admin.rows("tenant_group_managers").push({ group_id: GROUP_A, user_id: MANAGER });
});

describe("super-admin-only group management", () => {
  it("non super admin cannot create groups", async () => {
    await expect(
      createGroupFor(ctxFor(MANAGER), { nome: "Grupo Novo", isDemo: false }),
    ).rejects.toThrow("Apenas o super admin pode gerenciar grupos");
    expect(fake.admin.rows("tenant_groups")).toHaveLength(2);
    expect(fake.admin.rows("admin_audit_logs")).toHaveLength(0);
  });

  it("every mutation rejects a non super admin", async () => {
    const ctx = ctxFor(MANAGER);
    const message = "Apenas o super admin pode gerenciar grupos";
    await expect(listGroupsAdminFor(ctx)).rejects.toThrow(message);
    await expect(renameGroupFor(ctx, { groupId: GROUP_A, nome: "X Y" })).rejects.toThrow(message);
    await expect(deleteGroupFor(ctx, { groupId: GROUP_A })).rejects.toThrow(message);
    await expect(
      setGroupTenantsFor(ctx, { groupId: GROUP_A, tenantIds: [HOUSE_3] }),
    ).rejects.toThrow(message);
    await expect(
      addGroupManagerFor(ctx, { groupId: GROUP_A, email: "plain@example.com" }),
    ).rejects.toThrow(message);
    await expect(removeGroupManagerFor(ctx, { groupId: GROUP_A, userId: MANAGER })).rejects.toThrow(
      message,
    );
    expect(fake.admin.rows("tenant_group_managers")).toHaveLength(1);
    expect(fake.admin.rows("tenant_group_tenants")).toHaveLength(2);
  });

  it("creates, renames and deletes a group with audit entries", async () => {
    const ctx = ctxFor(SUPER);
    const { id } = await createGroupFor(ctx, { nome: "Grupo Novo", isDemo: true });
    const created = fake.admin.rows("tenant_groups").find((g) => g.id === id);
    expect(created).toMatchObject({ nome: "Grupo Novo", is_demo: true, created_by: SUPER });

    await renameGroupFor(ctx, { groupId: id, nome: "Grupo Renomeado" });
    expect(fake.admin.rows("tenant_groups").find((g) => g.id === id)?.nome).toBe("Grupo Renomeado");

    await deleteGroupFor(ctx, { groupId: id });
    expect(fake.admin.rows("tenant_groups").some((g) => g.id === id)).toBe(false);

    expect(fake.admin.rows("admin_audit_logs").map((row) => row.action)).toEqual([
      "group.created",
      "group.renamed",
      "group.deleted",
    ]);
    expect(fake.admin.rows("admin_audit_logs").every((row) => row.actor_user_id === SUPER)).toBe(
      true,
    );
  });

  it("setGroupTenants replaces the set and audits it", async () => {
    await setGroupTenantsFor(ctxFor(SUPER), { groupId: GROUP_A, tenantIds: [HOUSE_3] });
    expect(
      fake.admin
        .rows("tenant_group_tenants")
        .filter((row) => row.group_id === GROUP_A)
        .map((row) => row.tenant_id),
    ).toEqual([HOUSE_3]);
    const audit = fake.admin.rows("admin_audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "group.tenants_changed",
      before_data: { group_id: GROUP_A, tenant_ids: [HOUSE_1] },
      after_data: { group_id: GROUP_A, tenant_ids: [HOUSE_3] },
    });
  });

  it("setGroupTenants maps unique violation to friendly error", async () => {
    await expect(
      setGroupTenantsFor(ctxFor(SUPER), { groupId: GROUP_A, tenantIds: [HOUSE_1, HOUSE_2] }),
    ).rejects.toThrow("A casa já pertence a outro grupo");
    // Nothing changed: HOUSE_1 is still in A, HOUSE_2 still in B, no audit.
    expect(fake.admin.rows("tenant_group_tenants")).toEqual([
      expect.objectContaining({ group_id: GROUP_A, tenant_id: HOUSE_1 }),
      expect.objectContaining({ group_id: GROUP_B, tenant_id: HOUSE_2 }),
    ]);
    expect(fake.admin.rows("admin_audit_logs")).toHaveLength(0);
  });

  it("addGroupManager rejects super admin targets", async () => {
    await expect(
      addGroupManagerFor(ctxFor(SUPER), { groupId: GROUP_A, email: "outro.super@example.com" }),
    ).rejects.toThrow("Não é permitido vincular um superadmin global por esta área");
    expect(fake.admin.rows("tenant_group_managers")).toHaveLength(1);
  });

  it("addGroupManager requires an existing user (no invite)", async () => {
    await expect(
      addGroupManagerFor(ctxFor(SUPER), { groupId: GROUP_A, email: "ninguem@example.com" }),
    ).rejects.toThrow("Usuário não encontrado");
    expect(fake.admin.rows("tenant_group_managers")).toHaveLength(1);
  });

  it("adds and removes a group manager with audit entries", async () => {
    const ctx = ctxFor(SUPER);
    await addGroupManagerFor(ctx, { groupId: GROUP_B, email: " Plain@Example.com " });
    expect(fake.admin.rows("tenant_group_managers")).toContainEqual(
      expect.objectContaining({ group_id: GROUP_B, user_id: PLAIN, created_by: SUPER }),
    );
    await removeGroupManagerFor(ctx, { groupId: GROUP_B, userId: PLAIN });
    expect(fake.admin.rows("tenant_group_managers").some((m) => m.user_id === PLAIN)).toBe(false);
    expect(fake.admin.rows("admin_audit_logs")).toEqual([
      expect.objectContaining({ action: "group.manager_added", target_user_id: PLAIN }),
      expect.objectContaining({ action: "group.manager_removed", target_user_id: PLAIN }),
    ]);
  });

  it("lists groups with houses, managers and ungrouped houses", async () => {
    const result = await listGroupsAdminFor(ctxFor(SUPER));
    expect(result.groups).toEqual([
      {
        id: GROUP_A,
        nome: "Grupo A",
        is_demo: false,
        tenants: [{ id: HOUSE_1, nome: "Casa Um" }],
        managers: [{ user_id: MANAGER, email: "gestor.grupo@example.com" }],
      },
      {
        id: GROUP_B,
        nome: "Grupo B",
        is_demo: false,
        tenants: [{ id: HOUSE_2, nome: "Casa Dois" }],
        managers: [],
      },
    ]);
    expect(result.ungroupedTenants).toEqual([{ id: HOUSE_3, nome: "Casa Três", is_demo: false }]);
  });
});

describe("getGroupPeopleFor", () => {
  it("getGroupPeople rejects a group the user does not manage", async () => {
    await expect(getGroupPeopleFor(ctxFor(MANAGER), { groupId: GROUP_B })).rejects.toThrow(
      /Sem permissão/,
    );
    await expect(getGroupPeopleFor(ctxFor(PLAIN), { groupId: GROUP_A })).rejects.toThrow(
      /Sem permissão/,
    );
  });

  it("returns the members of each house of a managed group", async () => {
    fake.admin
      .rows("user_roles")
      .push(
        {
          id: "role-1",
          user_id: PLAIN,
          tenant_id: HOUSE_1,
          role: "gestor",
          created_at: "2026-01-01",
        },
        {
          id: "role-2",
          user_id: PLAIN,
          tenant_id: HOUSE_2,
          role: "admin",
          created_at: "2026-01-01",
        },
      );
    const result = await getGroupPeopleFor(ctxFor(MANAGER), { groupId: GROUP_A });
    expect(result).toEqual({
      tenants: [
        {
          id: HOUSE_1,
          nome: "Casa Um",
          is_demo: false,
          members: [
            {
              membership_id: "role-1",
              user_id: PLAIN,
              email: "plain@example.com",
              role: "gestor",
              canViewFinance: false,
            },
          ],
        },
      ],
    });
  });
});
