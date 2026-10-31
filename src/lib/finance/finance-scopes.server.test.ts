// Scope listing for the MCP server (Task 5): listFinanceScopesFor is
// LIST-ONLY — it never grants anything; every tool re-checks permission
// itself via can/requirePermission in finance-data.server.ts. Mirrors the
// createFakeDb fixture style of finance.functions.test.ts (SUPER, G1_MANAGER,
// ADMIN_A, MEMBER_A, HOUSE_A/B/C, DEMO, G1/G2).
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { listFinanceScopesFor } from "./finance-scopes.server";
import { createFakeDb } from "../sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const MEMBER_A = "00000000-0000-4000-8000-0000000000ee";
const G1 = "00000000-0000-4000-8000-00000000a001";
const G2 = "00000000-0000-4000-8000-00000000b001";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const DEMO = "00000000-0000-4000-8000-00000000d3d0";

type Row = Record<string, unknown>;
const roles = () => fake.admin.rows("user_roles");
const groupHouses = (userId: string) => {
  const groups = fake.admin
    .rows("tenant_group_managers")
    .filter((m) => m.user_id === userId)
    .map((m) => m.group_id);
  return fake.admin
    .rows("tenant_group_tenants")
    .filter((link) => groups.includes(link.group_id))
    .map((link) => link.tenant_id);
};
const hasRole = (user: unknown, tenant: unknown, role: string) =>
  roles().some((r) => r.user_id === user && r.tenant_id === tenant && r.role === role);

beforeEach(() => {
  fake.admin.reset();

  const isSuper = (u: unknown) => u === SUPER;
  const isGroupManager = (u: unknown, t: unknown) => groupHouses(String(u)).includes(t);
  const canView = (u: unknown, t: unknown) =>
    isSuper(u) ||
    hasRole(u, t, "admin") ||
    isGroupManager(u, t) ||
    (hasRole(u, t, "gestor") &&
      fake.admin.rows("tenant_finance_viewers").some((v) => v.user_id === u && v.tenant_id === t));

  fake.admin.onRpc("is_super_admin", ({ _user_id: u }) => ({ data: isSuper(u), error: null }));
  fake.admin.onRpc("finance_can_view", ({ _user: u, _tenant: t }) => ({
    data: canView(u, t),
    error: null,
  }));
  fake.admin.onRpc("group_ids_managed_by", ({ _user: u }) => ({
    data: isSuper(u)
      ? fake.admin.rows("tenant_groups").map((g) => g.id)
      : fake.admin
          .rows("tenant_group_managers")
          .filter((m) => m.user_id === u)
          .map((m) => m.group_id),
    error: null,
  }));

  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", status: "active", is_demo: false },
      { id: HOUSE_B, nome: "Casa B", status: "active", is_demo: false },
      { id: HOUSE_C, nome: "Casa C", status: "active", is_demo: false },
      { id: DEMO, nome: "Casa Demo", status: "active", is_demo: true },
    );
  fake.admin
    .rows("tenant_groups")
    .push({ id: G1, nome: "Grupo 1", is_demo: false }, { id: G2, nome: "Grupo 2", is_demo: false });
  fake.admin
    .rows("tenant_group_tenants")
    .push(
      { group_id: G1, tenant_id: HOUSE_A },
      { group_id: G1, tenant_id: HOUSE_B },
      { group_id: G2, tenant_id: HOUSE_C },
    );
  fake.admin.rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  roles().push(
    { id: "r1", user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin", created_at: "2026-01-01" },
    { id: "r2", user_id: MEMBER_A, tenant_id: HOUSE_A, role: "member", created_at: "2026-01-02" },
  );
});

describe("listFinanceScopesFor", () => {
  it("super admin sees every house (demo marked) and every group", async () => {
    const scopes = await listFinanceScopesFor(SUPER);
    expect(scopes.superAdmin).toBe(true);
    expect(scopes.houses).toEqual([
      { id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" },
      { id: HOUSE_B, nome: "Casa B", isDemo: false, status: "active" },
      { id: HOUSE_C, nome: "Casa C", isDemo: false, status: "active" },
      { id: DEMO, nome: "Casa Demo", isDemo: true, status: "active" },
    ]);
    expect(scopes.groups).toEqual([
      { id: G1, nome: "Grupo 1", isDemo: false },
      { id: G2, nome: "Grupo 2", isDemo: false },
    ]);
  });

  it("house admin sees only that house and no groups", async () => {
    const scopes = await listFinanceScopesFor(ADMIN_A);
    expect(scopes.superAdmin).toBe(false);
    expect(scopes.houses).toEqual([
      { id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" },
    ]);
    expect(scopes.groups).toEqual([]);
  });

  it("group manager sees the group and its houses", async () => {
    const scopes = await listFinanceScopesFor(G1_MANAGER);
    expect(scopes.superAdmin).toBe(false);
    expect(scopes.houses).toEqual([
      { id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" },
      { id: HOUSE_B, nome: "Casa B", isDemo: false, status: "active" },
    ]);
    expect(scopes.groups).toEqual([{ id: G1, nome: "Grupo 1", isDemo: false }]);
  });

  it("a member without finance_can_view sees nothing", async () => {
    const scopes = await listFinanceScopesFor(MEMBER_A);
    expect(scopes.superAdmin).toBe(false);
    expect(scopes.houses).toEqual([]);
    expect(scopes.groups).toEqual([]);
  });
});
