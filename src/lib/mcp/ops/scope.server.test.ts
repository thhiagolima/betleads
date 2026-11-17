// MCP do grupo, §8 "Testes que importam" (permission part): resolverEscopoOps
// is the only gate of the operação tools. Same createFakeDb stand-in as the
// other mcp/*.test.ts files; the three RPCs it calls (mcp_ops_tenant_ids,
// mcp_ops_can_view, group_ids_managed_by) are emulated here with the exact
// rule of migration 20261231101400 (the SQL itself is covered by
// mcp-grupo-schema.db.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { MAX_OPS_TENANTS } from "../config.server";
import {
  ESCOPO_GRANDE,
  SEM_ACESSO_CASA,
  SEM_ACESSO_GRUPO,
  SEM_CASAS,
  TODAS_ROTULO,
  listarEscoposOps,
  resolverEscopoOps,
} from "./scope.server";
import { createFakeDb } from "../../sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_AC = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_A = "00000000-0000-4000-8000-0000000000dd";
const MEMBER_A = "00000000-0000-4000-8000-0000000000ee";
const ADMIN_D = "00000000-0000-4000-8000-0000000000ff";

const G1 = "00000000-0000-4000-8000-00000000a001";
const G2 = "00000000-0000-4000-8000-00000000a002";
const GDEMO = "00000000-0000-4000-8000-00000000a0d0";

const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const HOUSE_D = "00000000-0000-4000-8000-000000000104";
const DEMO = "00000000-0000-4000-8000-00000000d0d0";

type Row = Record<string, unknown>;
const rows = (table: string) => fake.admin.rows(table);

const isSuper = (user: unknown) =>
  rows("user_roles").some((r) => r.user_id === user && r.role === "super_admin");
const managedGroups = (user: unknown) =>
  isSuper(user)
    ? rows("tenant_groups").map((g) => g.id as string)
    : rows("tenant_group_managers")
        .filter((m) => m.user_id === user)
        .map((m) => m.group_id as string);
/** Same rule as public.mcp_ops_tenant_ids. */
function opsTenantIds(user: unknown): string[] {
  if (isSuper(user)) return rows("tenants").map((t) => t.id as string);
  const admin = rows("user_roles")
    .filter((r) => r.user_id === user && r.role === "admin" && r.tenant_id)
    .map((r) => r.tenant_id as string);
  const groups = managedGroups(user);
  const grouped = rows("tenant_group_tenants")
    .filter((link) => groups.includes(link.group_id as string))
    .map((link) => link.tenant_id as string);
  return Array.from(new Set([...admin, ...grouped]));
}

function tenant(id: string, nome: string, extra: Row = {}): Row {
  return { id, nome, moeda: "BRL", status: "active", is_demo: false, ...extra };
}

beforeEach(() => {
  fake.admin.reset();
  fake.admin.onRpc("mcp_ops_tenant_ids", (args) => ({
    data: opsTenantIds(args._user),
    error: null,
  }));
  fake.admin.onRpc("mcp_ops_can_view", (args) => ({
    data: opsTenantIds(args._user).includes(args._tenant as string),
    error: null,
  }));
  fake.admin.onRpc("group_ids_managed_by", (args) => ({
    data: managedGroups(args._user),
    error: null,
  }));

  rows("tenants").push(
    tenant(HOUSE_A, "Casa A", { moeda: null }),
    tenant(HOUSE_B, "Casa B", { status: "suspended" }),
    tenant(HOUSE_C, "Casa C", { moeda: "ars" }),
    tenant(HOUSE_D, "Casa D"),
    tenant(DEMO, "Casa Demo", { is_demo: true }),
  );
  rows("tenant_groups").push(
    { id: G1, nome: "Grupo Um", is_demo: false },
    { id: G2, nome: "Grupo Dois", is_demo: false },
    { id: GDEMO, nome: "Grupo Demo", is_demo: true },
  );
  rows("tenant_group_tenants").push(
    { group_id: G1, tenant_id: HOUSE_A },
    { group_id: G1, tenant_id: HOUSE_B },
    { group_id: G2, tenant_id: HOUSE_C },
    { group_id: GDEMO, tenant_id: DEMO },
  );
  rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  rows("user_roles").push(
    { user_id: SUPER, role: "super_admin", tenant_id: null },
    { user_id: ADMIN_AC, role: "admin", tenant_id: HOUSE_A },
    { user_id: ADMIN_AC, role: "admin", tenant_id: HOUSE_C },
    { user_id: ADMIN_D, role: "admin", tenant_id: HOUSE_D },
    { user_id: GESTOR_A, role: "gestor", tenant_id: HOUSE_A },
    { user_id: MEMBER_A, role: "member", tenant_id: HOUSE_A },
  );
});

const ids = (result: { casas: Array<{ id: string }> }) => result.casas.map((casa) => casa.id);

describe("resolverEscopoOps — group manager", () => {
  it("sees the houses of the group they manage, with the group on each house", async () => {
    const result = await resolverEscopoOps(G1_MANAGER, { tipo: "grupo", id: G1 });
    expect(result.rotulo).toBe("Grupo Um");
    expect(result.casas).toEqual([
      {
        id: HOUSE_A,
        nome: "Casa A",
        moeda: "BRL",
        status: "active",
        isDemo: false,
        grupo: { id: G1, nome: "Grupo Um" },
      },
      {
        id: HOUSE_B,
        nome: "Casa B",
        moeda: "BRL",
        status: "suspended",
        isDemo: false,
        grupo: { id: G1, nome: "Grupo Um" },
      },
    ]);
  });

  it("does not see another group, nor its house by id", async () => {
    await expect(resolverEscopoOps(G1_MANAGER, { tipo: "grupo", id: G2 })).rejects.toThrow(
      SEM_ACESSO_GRUPO,
    );
    await expect(resolverEscopoOps(G1_MANAGER, { tipo: "casa", id: HOUSE_C })).rejects.toThrow(
      SEM_ACESSO_CASA,
    );
  });

  it("can ask for one house of the group directly", async () => {
    const result = await resolverEscopoOps(G1_MANAGER, { tipo: "casa", id: HOUSE_B });
    expect(ids(result)).toEqual([HOUSE_B]);
    expect(result.rotulo).toBe("Casa B");
  });

  it("todas = the group's houses", async () => {
    const result = await resolverEscopoOps(G1_MANAGER, { tipo: "todas" });
    expect(ids(result)).toEqual([HOUSE_A, HOUSE_B]);
    expect(result.rotulo).toBe(TODAS_ROTULO);
  });
});

describe("resolverEscopoOps — house admin", () => {
  it("the admin of house D does not see house A", async () => {
    expect(ids(await resolverEscopoOps(ADMIN_D, { tipo: "casa", id: HOUSE_D }))).toEqual([HOUSE_D]);
    await expect(resolverEscopoOps(ADMIN_D, { tipo: "casa", id: HOUSE_A })).rejects.toThrow(
      SEM_ACESSO_CASA,
    );
  });

  it("todas for an admin of 2 houses returns exactly those 2, with their currency", async () => {
    const result = await resolverEscopoOps(ADMIN_AC, { tipo: "todas" });
    expect(result.casas.map((casa) => [casa.id, casa.moeda])).toEqual([
      [HOUSE_A, "BRL"],
      [HOUSE_C, "ARS"],
    ]);
  });

  it("being admin of a house in a group does not open the group", async () => {
    await expect(resolverEscopoOps(ADMIN_AC, { tipo: "grupo", id: G1 })).rejects.toThrow(
      SEM_ACESSO_GRUPO,
    );
  });
});

describe("resolverEscopoOps — gestor and member see nothing", () => {
  for (const [label, user] of [
    ["gestor", GESTOR_A],
    ["member", MEMBER_A],
  ] as const) {
    it(`${label}: casa, grupo and todas are refused`, async () => {
      await expect(resolverEscopoOps(user, { tipo: "casa", id: HOUSE_A })).rejects.toThrow(
        SEM_ACESSO_CASA,
      );
      await expect(resolverEscopoOps(user, { tipo: "grupo", id: G1 })).rejects.toThrow(
        SEM_ACESSO_GRUPO,
      );
      await expect(resolverEscopoOps(user, { tipo: "todas" })).rejects.toThrow(SEM_CASAS);
    });
  }
});

describe("resolverEscopoOps — super admin and demo", () => {
  it("todas = every real house, demo left out", async () => {
    const result = await resolverEscopoOps(SUPER, { tipo: "todas" });
    expect(ids(result)).toEqual([HOUSE_A, HOUSE_B, HOUSE_C, HOUSE_D]);
  });

  it("a demo house comes when asked for directly, or through its demo group", async () => {
    const direct = await resolverEscopoOps(SUPER, { tipo: "casa", id: DEMO });
    expect(direct.casas[0]).toMatchObject({ id: DEMO, isDemo: true });
    const group = await resolverEscopoOps(SUPER, { tipo: "grupo", id: GDEMO });
    expect(ids(group)).toEqual([DEMO]);
  });

  it("an unknown house is refused like a forbidden one", async () => {
    await expect(
      resolverEscopoOps(SUPER, { tipo: "casa", id: "00000000-0000-4000-8000-000000000999" }),
    ).rejects.toThrow(SEM_ACESSO_CASA);
  });
});

describe(`resolverEscopoOps — at most ${MAX_OPS_TENANTS} houses`, () => {
  const many = (count: number, prefix: string) =>
    Array.from(
      { length: count },
      (_, i) => `00000000-0000-4000-8000-${prefix}${String(i).padStart(12 - prefix.length, "0")}`,
    );

  it("todas above the limit asks to narrow by group", async () => {
    const extra = many(MAX_OPS_TENANTS - 3, "e");
    rows("tenants").push(...extra.map((id, i) => tenant(id, `Extra ${i}`)));
    // 4 real + 57 = 61 real houses (the demo one does not count).
    await expect(resolverEscopoOps(SUPER, { tipo: "todas" })).rejects.toThrow(ESCOPO_GRANDE);
  });

  it(`todas with exactly ${MAX_OPS_TENANTS} real houses passes`, async () => {
    const extra = many(MAX_OPS_TENANTS - 4, "e");
    rows("tenants").push(...extra.map((id, i) => tenant(id, `Extra ${i}`)));
    const result = await resolverEscopoOps(SUPER, { tipo: "todas" });
    expect(result.casas).toHaveLength(MAX_OPS_TENANTS);
  });

  it("a group above the limit is refused too", async () => {
    const extra = many(MAX_OPS_TENANTS - 1, "f");
    rows("tenants").push(...extra.map((id, i) => tenant(id, `Extra ${i}`)));
    rows("tenant_group_tenants").push(...extra.map((id) => ({ group_id: G1, tenant_id: id })));
    await expect(resolverEscopoOps(G1_MANAGER, { tipo: "grupo", id: G1 })).rejects.toThrow(
      ESCOPO_GRANDE,
    );
  });
});

describe("listarEscoposOps", () => {
  it("lists the group manager's houses and groups with house counts", async () => {
    const result = await listarEscoposOps(G1_MANAGER);
    expect(ids(result)).toEqual([HOUSE_A, HOUSE_B]);
    expect(result.grupos).toEqual([{ id: G1, nome: "Grupo Um", isDemo: false, casas: 2 }]);
  });

  it("super admin: every house (demo marked) and every group", async () => {
    const result = await listarEscoposOps(SUPER);
    expect(ids(result)).toEqual([HOUSE_A, HOUSE_B, HOUSE_C, HOUSE_D, DEMO]);
    expect(result.casas.find((casa) => casa.id === DEMO)?.isDemo).toBe(true);
    expect(result.grupos.map((g) => [g.nome, g.casas])).toEqual([
      ["Grupo Demo", 1],
      ["Grupo Dois", 1],
      ["Grupo Um", 2],
    ]);
  });

  it("gestor: nothing", async () => {
    expect(await listarEscoposOps(GESTOR_A)).toEqual({ casas: [], grupos: [] });
  });
});
