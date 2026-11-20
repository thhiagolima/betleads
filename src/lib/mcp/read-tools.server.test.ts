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

import { serieDiaria } from "@/lib/api/serie-diaria.server";
import { getFinanceDashboardFor } from "@/lib/finance-dashboard.functions";

import {
  listarEscopos,
  mesDaCasa,
  metasDaCasa,
  resumoFinanceiro,
  resumoPorDia,
} from "./read-tools.server";
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
  areas: ["financeiro"],
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
    expect(resumo.kpis).toEqual(direct.kpis);
    expect(resumo.rotulo).toBe(direct.label);
    expect(resumo.casas).toEqual(
      direct.tenants.map((tenant) => ({
        id: tenant.id,
        nome: tenant.nome,
        moeda: tenant.moeda,
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
    expect(resumo.kpis).toEqual(direct.kpis);
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

describe("resumoPorDia", () => {
  it("each day equals a one-day resumo_financeiro, in one call", async () => {
    financeDayRows.push(complete(HOUSE_A, "2026-10-20", 1000, 100));
    financeDayRows.push(complete(HOUSE_B, "2026-10-21", 500, 50));

    const porDia = await resumoPorDia(identity(SUPER), {
      escopo: { tipo: "grupo", id: G1 },
      periodo: { inicio: "2026-10-20", fim: "2026-10-21" },
    });

    expect(porDia.periodo).toEqual({ inicio: "2026-10-20", fim: "2026-10-21" });
    expect(porDia.dias.map((dia) => dia.data)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(porDia.dias_com_erro).toEqual([]);
    for (const dia of porDia.dias) {
      const umDia = await resumoFinanceiro(identity(SUPER), {
        escopo: { tipo: "grupo", id: G1 },
        periodo: { preset: "custom", inicio: dia.data, fim: dia.data },
        comparar: "none",
      });
      expect(dia.totais).toEqual(umDia.totais?.current ?? null);
      expect(dia.casas).toEqual(
        umDia.casas.map((casa) => ({ id: casa.id, nome: casa.nome, moeda: casa.moeda, atual: casa.atual })),
      );
    }
    expect(porDia.dias[0].totais?.depositAmount).toBe(1000);
    expect(porDia.dias[1].totais?.depositAmount).toBe(500);
  });

  it("stops at today", async () => {
    const porDia = await resumoPorDia(identity(SUPER), {
      escopo: { tipo: "casa", id: HOUSE_A },
      periodo: { inicio: "2026-10-23", fim: "2026-10-30" },
    });
    expect(porDia.dias.map((dia) => dia.data)).toEqual(["2026-10-23", "2026-10-24"]);
  });

  it("a house outside the caller's scope is refused", async () => {
    await expect(
      resumoPorDia(identity(ADMIN_A), {
        escopo: { tipo: "casa", id: HOUSE_B },
        periodo: { inicio: "2026-10-20", fim: "2026-10-21" },
      }),
    ).rejects.toThrow("Sem permissão");
  });
});

// API de leitura (src/lib/api/serie-diaria.server.ts): same fixtures as the
// finance read tools, since it reads the same daily sources.
describe("serieDiaria (API)", () => {
  it("one row per house per day, equal to that day in the panel, plus CRM and send cost", async () => {
    financeDayRows.push(
      complete(HOUSE_A, "2026-10-20", 1000, 100),
      dayRow(HOUSE_A, "2026-10-21", { registrations: 7, ftds: 2, deposit_amount: 300 }),
      complete(HOUSE_B, "2026-10-20", 500, 50),
      complete(HOUSE_B, "2026-10-21", 250, 25),
    );
    fake.admin.onRpc("finance_activity_days", () => ({
      data: [
        {
          tenant_id: HOUSE_A,
          metric_date: "2026-10-20",
          deposit_count: 4,
          depositor_count: 3,
          withdrawal_count: 1,
          crm_sent: 100,
          crm_clicks: 9,
          crm_direct_conversions: 2,
          crm_direct_revenue: "150.505",
        },
      ],
      error: null,
    }));
    fake.admin.onRpc("finance_send_usage", () => ({
      data: [
        { tenant_id: HOUSE_A, metric_date: "2026-10-20", item: "sms", units: 100, amount: "5.9", missing_cost_units: 0 },
      ],
      error: null,
    }));

    const serie = await serieDiaria(identity(SUPER), {
      escopo: { tipo: "grupo", id: G1 },
      periodo: { inicio: "2026-10-20", fim: "2026-10-21" },
    });

    expect(serie.rotulo).toBe("Grupo 1");
    expect(serie.periodo).toEqual({ inicio: "2026-10-20", fim: "2026-10-21" });
    expect(serie.linhas.map((l) => `${l.data}|${l.casa_id}`)).toEqual([
      `2026-10-20|${HOUSE_A}`,
      `2026-10-20|${HOUSE_B}`,
      `2026-10-21|${HOUSE_A}`,
      `2026-10-21|${HOUSE_B}`,
    ]);

    // Each house-day equals the panel with that single day selected.
    for (const linha of serie.linhas) {
      const umDia = await resumoFinanceiro(identity(SUPER), {
        escopo: { tipo: "casa", id: linha.casa_id },
        periodo: { preset: "custom", inicio: linha.data, fim: linha.data },
        comparar: "none",
      });
      const atual = umDia.casas[0].atual;
      expect(linha.valor_depositado).toBe(atual.depositAmount);
      expect(linha.cadastros).toBe(atual.registrations);
      expect(linha.ftds).toBe(atual.ftds);
      expect(linha.net).toBe(atual.net);
      expect(linha.anuncios ?? 0).toBe(atual.adSpend);
    }

    const a20 = serie.linhas[0];
    expect(a20).toMatchObject({
      depositos: 4,
      depositantes: 3,
      saques: 1,
      crm_enviados: 100,
      crm_cliques: 9,
      crm_conversoes_diretas: 2,
      crm_receita_direta: 150.51,
      custo_envios_brl: 5.9,
      pendente: false,
    });
    // 10-21 of house A has no ad spend nor GGR: pending, with nulls.
    expect(serie.linhas[2]).toMatchObject({ anuncios: null, ggr: null, pendente: true, custo_envios_brl: 0 });
  });

  it("splits a month's accumulated GGR over the days like the panel, even mid-month", async () => {
    for (let d = 1; d <= 24; d++) {
      financeDayRows.push(dayRow(HOUSE_A, `2026-10-${String(d).padStart(2, "0")}`, { ad_spend: 0 }));
    }
    fake.admin
      .rows("tenant_finance_monthly_ggr")
      .push({ tenant_id: HOUSE_A, month: "2026-10-01", ggr: 2400, valid_through: "2026-10-24" });

    const serie = await serieDiaria(identity(SUPER), {
      escopo: { tipo: "casa", id: HOUSE_A },
      periodo: { inicio: "2026-10-20", fim: "2026-10-21" },
    });
    for (const linha of serie.linhas) {
      const umDia = await resumoFinanceiro(identity(SUPER), {
        escopo: { tipo: "casa", id: HOUSE_A },
        periodo: { preset: "custom", inicio: linha.data, fim: linha.data },
        comparar: "none",
      });
      expect(linha.ggr_estimado).toBe(true);
      expect(linha.ggr).toBe(umDia.casas[0].atual.ggr);
    }
  });

  it("stops at today, refuses more than 366 days and a house outside the scope", async () => {
    const ate = await serieDiaria(identity(SUPER), {
      escopo: { tipo: "casa", id: HOUSE_A },
      periodo: { inicio: "2026-10-23", fim: "2026-12-31" },
    });
    expect(ate.periodo).toEqual({ inicio: "2026-10-23", fim: "2026-10-24" });

    await expect(
      serieDiaria(identity(SUPER), {
        escopo: { tipo: "casa", id: HOUSE_A },
        periodo: { inicio: "2025-10-01", fim: "2026-10-24" },
      }),
    ).rejects.toThrow("No máximo 366 dias");

    await expect(
      serieDiaria(identity(ADMIN_A), {
        escopo: { tipo: "casa", id: HOUSE_B },
        periodo: { inicio: "2026-10-20", fim: "2026-10-21" },
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
