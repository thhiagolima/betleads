// MCP financeiro, Task 6: read tools over the finance panel functions.
// Same createFakeDb stand-in and permission model as
// finance-dashboard.functions.test.ts / finance.functions.test.ts — these
// tools call the exact same `*For` cores, so the fixtures mirror theirs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { getFinanceDashboardFor } from "@/lib/finance-dashboard.functions";

import { listarEscopos, mesDaCasa, metasDaCasa, resumoFinanceiro } from "./read-tools.server";
import type { McpIdentity } from "./access.server";
import { createFakeDb } from "../sms-bulk.test-support";

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const G1_MANAGER = "00000000-0000-4000-8000-0000000000bb";
const ADMIN_A = "00000000-0000-4000-8000-0000000000cc";
const GESTOR_A = "00000000-0000-4000-8000-0000000000dd";
const G1 = "00000000-0000-4000-8000-00000000a001";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";

const identity = (userId: string, level: "read" | "write" = "read"): McpIdentity => ({
  userId,
  connectionId: "conn-1",
  clientId: "client-1",
  level,
});

type Row = Record<string, unknown>;
let financeDayRows: Row[];

function dayRow(tenantId: string, date: string, overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    metric_date: date,
    registrations: 0,
    ftds: 0,
    ftd_deposit_amount: 0,
    deposit_amount: 0,
    withdrawal_amount: 0,
    ad_spend: null,
    ad_spend_suggested: null,
    ggr: null,
    ggr_fee_pct: 0,
    movement_fee_pct: 0,
    ...overrides,
  };
}

const complete = (tenantId: string, date: string, deposit: number, adSpend: number) =>
  dayRow(tenantId, date, { deposit_amount: deposit, ad_spend: adSpend, ggr: 0 });

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

const monthToDate = {
  periodo: { preset: "month" as const },
  comparar: "previous" as const,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 12:00 in São Paulo on 2026-10-24 (matches the other finance test files).
  vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));
  fake.admin.reset();
  financeDayRows = [];

  const isSuper = (u: unknown) => u === SUPER;
  const isGroupManager = (u: unknown, t: unknown) => groupHouses(String(u)).includes(t);
  const canEditRates = (u: unknown, t: unknown) =>
    isSuper(u) || hasRole(u, t, "admin") || isGroupManager(u, t);
  fake.admin.onRpc("is_super_admin", ({ _user_id: u }) => ({ data: isSuper(u), error: null }));
  fake.admin.onRpc("finance_can_view", ({ _user: u, _tenant: t }) => ({
    data:
      canEditRates(u, t) ||
      (hasRole(u, t, "gestor") &&
        fake.admin
          .rows("tenant_finance_viewers")
          .some((v) => v.user_id === u && v.tenant_id === t)),
    error: null,
  }));
  fake.admin.onRpc("finance_can_edit_values", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || hasRole(u, t, "admin"),
    error: null,
  }));
  fake.admin.onRpc("finance_can_edit_rates", ({ _user: u, _tenant: t }) => ({
    data: canEditRates(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_viewers", ({ _user: u, _tenant: t }) => ({
    data: canEditRates(u, t),
    error: null,
  }));
  fake.admin.onRpc("finance_can_manage_goals", ({ _user: u, _tenant: t }) => ({
    data: isSuper(u) || isGroupManager(u, t),
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

  const ofTenants = (row: Row, args: Row) =>
    (args._tenants as string[]).includes(String(row.tenant_id));
  const inWindow = (row: Row, args: Row) =>
    ofTenants(row, args) &&
    String(row.metric_date) >= String(args._from) &&
    String(row.metric_date) <= String(args._to);
  fake.admin.onRpc("finance_days", (args) => ({
    data: financeDayRows.filter((row) => inWindow(row, args)),
    error: null,
  }));
  fake.admin.onRpc("finance_goal_days", () => ({ data: [], error: null }));
  fake.admin.onRpc("finance_send_usage", () => ({ data: [], error: null }));
  fake.admin.onRpc("finance_activity_days", () => ({ data: [], error: null }));
  fake.admin.onRpc("finance_betleads_fees", () => ({ data: [], error: null }));
  fake.admin.onRpc("finance_tenants_exempt", (args) => ({
    data: [...new Set(args._tenants as string[])].map((id) => ({ tenant_id: id, exempt: false })),
    error: null,
  }));
  fake.admin.onRpc("finance_betleads_since", () => ({ data: [], error: null }));

  fake.admin
    .rows("tenants")
    .push(
      { id: HOUSE_A, nome: "Casa A", status: "active", is_demo: false },
      { id: HOUSE_B, nome: "Casa B", status: "active", is_demo: false },
    );
  fake.admin.rows("tenant_groups").push({ id: G1, nome: "Grupo 1", is_demo: false });
  fake.admin
    .rows("tenant_group_tenants")
    .push({ group_id: G1, tenant_id: HOUSE_A }, { group_id: G1, tenant_id: HOUSE_B });
  fake.admin.rows("tenant_group_managers").push({ group_id: G1, user_id: G1_MANAGER });
  roles().push(
    { id: "r1", user_id: ADMIN_A, tenant_id: HOUSE_A, role: "admin", created_at: "2026-01-01" },
    { id: "r2", user_id: GESTOR_A, tenant_id: HOUSE_A, role: "gestor", created_at: "2026-01-02" },
  );
  fake.admin.rows("tenant_finance_viewers").push({ tenant_id: HOUSE_A, user_id: GESTOR_A });
  (fake.admin.client as unknown as Record<string, unknown>).auth = {
    admin: {
      listUsers: async () => ({
        data: {
          users: [
            { id: ADMIN_A, email: "admin.a@example.com" },
            { id: GESTOR_A, email: "gestor.a@example.com" },
          ],
        },
        error: null,
      }),
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resumoFinanceiro", () => {
  it("totals equal getFinanceDashboardFor's, for a house scope", async () => {
    financeDayRows.push(complete(HOUSE_A, "2026-10-20", 1000, 100));

    const direct = await getFinanceDashboardFor(
      { userId: SUPER },
      {
        scope: { kind: "tenant", tenantId: HOUSE_A },
        range: { from: "2026-10-01", to: "2026-10-24" },
        compare: "previous",
        preset: "month",
      },
    );
    const resumo = await resumoFinanceiro(identity(SUPER), {
      escopo: { tipo: "casa", id: HOUSE_A },
      ...monthToDate,
    });

    expect(resumo.totais).toEqual(direct.totals);
    expect(resumo.rotulo).toBe(direct.label);
    expect(resumo.casas).toEqual(
      direct.tenants.map((tenant) => ({
        id: tenant.id,
        nome: tenant.nome,
        atual: tenant.current,
        anterior: tenant.previous,
        metas: tenant.goals,
        pendentes: tenant.pendingDates,
      })),
    );
  });

  it("totals equal getFinanceDashboardFor's, for a group scope", async () => {
    financeDayRows.push(complete(HOUSE_A, "2026-10-20", 1000, 100));
    financeDayRows.push(complete(HOUSE_B, "2026-10-21", 500, 50));

    const direct = await getFinanceDashboardFor(
      { userId: SUPER },
      {
        scope: { kind: "group", groupId: G1 },
        range: { from: "2026-10-01", to: "2026-10-24" },
        compare: "previous",
        preset: "month",
      },
    );
    const resumo = await resumoFinanceiro(identity(SUPER), {
      escopo: { tipo: "grupo", id: G1 },
      ...monthToDate,
    });

    expect(resumo.totais).toEqual(direct.totals);
  });

  it('{tipo:"todas"} for a non-super-admin is refused', async () => {
    await expect(
      resumoFinanceiro(identity(ADMIN_A), { escopo: { tipo: "todas" }, ...monthToDate }),
    ).rejects.toThrow("Sem permissão");
  });

  it("a house outside the caller's scope is refused", async () => {
    await expect(
      resumoFinanceiro(identity(ADMIN_A), {
        escopo: { tipo: "casa", id: HOUSE_B },
        ...monthToDate,
      }),
    ).rejects.toThrow("Sem permissão");
  });
});

describe("mesDaCasa", () => {
  it("never returns viewers or e-mails, even for a user who can manage them", async () => {
    const result = await mesDaCasa(identity(ADMIN_A), { casa: HOUSE_A, mes: "2026-10" });
    const json = JSON.stringify(result);
    expect(json).not.toContain("@");
    expect(json.includes('"viewers"')).toBe(false);
    expect(result).not.toHaveProperty("viewers");
  });

  it("a house outside the caller's scope is refused", async () => {
    await expect(
      mesDaCasa(identity(ADMIN_A), { casa: HOUSE_B, mes: "2026-10" }),
    ).rejects.toThrow("Sem permissão");
  });

  it("a group id typed as a house id is refused, never a partial read", async () => {
    await expect(mesDaCasa(identity(ADMIN_A), { casa: G1, mes: "2026-10" })).rejects.toThrow(
      "Sem permissão",
    );
  });
});

describe("metasDaCasa", () => {
  it("returns the goals of a house the caller may view", async () => {
    const goals = await metasDaCasa(identity(ADMIN_A), { casa: HOUSE_A });
    expect(Array.isArray(goals)).toBe(true);
  });

  it("a house outside the caller's scope is refused", async () => {
    await expect(metasDaCasa(identity(ADMIN_A), { casa: HOUSE_B })).rejects.toThrow(
      "Sem permissão",
    );
  });
});

describe("listarEscopos", () => {
  it("adds the MCP access level to the scopes listing", async () => {
    const read = await listarEscopos(identity(ADMIN_A, "read"));
    expect(read.nivel).toBe("leitura");
    expect(read.houses).toEqual([
      { id: HOUSE_A, nome: "Casa A", isDemo: false, status: "active" },
    ]);

    const write = await listarEscopos(identity(ADMIN_A, "write"));
    expect(write.nivel).toBe("leitura e escrita");
  });
});
