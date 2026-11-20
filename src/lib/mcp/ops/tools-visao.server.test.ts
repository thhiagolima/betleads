// MCP do grupo, área de operação: visao_geral and comparar_casas (spec
// 2026-11-17 §5.2, §5.3, §8). resolverEscopoOps is mocked: it is the only
// permission gate, so these tests assert the tools query exactly the houses
// it returns (and nothing else), and the per-house/per-currency shape.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));
const mocks = vi.hoisted(() => ({ resolverEscopoOps: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

vi.mock("./scope.server", () => ({ resolverEscopoOps: mocks.resolverEscopoOps }));

import {
  dashboardPeriodBounds,
  mapDashboardRpc,
  type DashboardRpc,
} from "@/lib/dashboard.functions";

import type { McpIdentity } from "../access.server";
import { createFakeDb } from "../../sms-bulk.test-support";
import { assertSemDadosPessoais } from "./runner.server";
import type { CasaOps } from "./scope.server";
import {
  compararCasas,
  kpisAtuais,
  VISAO_TOOLS,
  visaoGeral,
  visaoGeralPorDia,
} from "./tools-visao.server";

const USER = "00000000-0000-4000-8000-0000000000bb";
const HOUSE_A = "00000000-0000-4000-8000-000000000101";
const HOUSE_B = "00000000-0000-4000-8000-000000000102";
const HOUSE_C = "00000000-0000-4000-8000-000000000103";
const HOUSE_OTHER = "00000000-0000-4000-8000-000000000199";
const GROUP = "00000000-0000-4000-8000-00000000a001";

const identity: McpIdentity = {
  userId: USER,
  connectionId: "conn-1",
  clientId: "client-1",
  level: "read",
  areas: ["operacao"],
};

const casa = (id: string, nome: string, moeda: CasaOps["moeda"], grupo = true): CasaOps => ({
  id,
  nome,
  moeda,
  status: "ativo",
  isDemo: false,
  grupo: grupo ? { id: GROUP, nome: "Grupo Um" } : null,
});
const A = casa(HOUSE_A, "Casa A", "BRL");
const B = casa(HOUSE_B, "Casa B", "BRL");
const C = casa(HOUSE_C, "Casa C", "ARS", false);

const NOW = new Date("2026-11-17T15:00:00.000Z");
const PERIODO = { inicio: "2026-11-10", fim: "2026-11-16" };

function payload(overrides: Partial<DashboardRpc> = {}): DashboardRpc {
  return {
    depositAmount: "1500.555",
    previousDepositAmount: 1000,
    depositCount: 30,
    previousDepositCount: 20,
    depositors: 12,
    previousDepositors: 10,
    newPlayers: 40,
    previousNewPlayers: 35,
    ftd: 8,
    previousFtd: 6,
    withdrawalAmount: "400.1",
    previousWithdrawalAmount: 300,
    withdrawalCount: 5,
    smsSent: 999,
    messageCost: 12,
    walletBalance: 50,
    // Player data the RPC carries for the live feed: must never leave the tool.
    liveEvents: [
      {
        id: "e1",
        tone: "green",
        player: "Fulano",
        action: "depositou",
        at: "2026-11-16T10:00:00Z",
        playerId: "p1",
      },
    ],
    ...overrides,
  };
}

type Row = Record<string, unknown>;
let dashboardCalls: Row[];
let lifecycleCalls: string[];
let bulkCalls: Array<{ fn: string; tenants: string[] }>;
let payloads: Map<string, DashboardRpc | { error: string }>;

beforeEach(() => {
  fake.admin.reset();
  mocks.resolverEscopoOps.mockReset();
  dashboardCalls = [];
  lifecycleCalls = [];
  bulkCalls = [];
  payloads = new Map<string, DashboardRpc | { error: string }>([
    [HOUSE_A, payload()],
    [HOUSE_B, payload({ depositAmount: 500, depositCount: 10, withdrawalAmount: 100 })],
    [HOUSE_C, payload({ depositAmount: 90000, depositCount: 3, withdrawalAmount: 0 })],
    [HOUSE_OTHER, payload()],
  ]);

  fake.admin
    .rows("dashboard_settings")
    .push({ tenant_id: HOUSE_A, id: "global", reset_at: "2026-01-01T00:00:00Z" });

  fake.admin.onRpc("dashboard_summary_v2", (args) => {
    dashboardCalls.push(args);
    const value = payloads.get(String(args._tenant));
    if (value && "error" in value) return { data: null, error: { message: String(value.error) } };
    return { data: value ?? null, error: null };
  });
  fake.admin.onRpc("crm_lifecycle_snapshot", (args) => {
    lifecycleCalls.push(String(args._tenant));
    return {
      data: [
        { state: "ativo", players: 5 },
        { state: "perdido", players: "2" },
      ],
      error: null,
    };
  });
  fake.admin.onRpc("finance_activity_days", (args) => {
    const tenants = args._tenants as string[];
    bulkCalls.push({ fn: "finance_activity_days", tenants });
    return {
      data: tenants.flatMap((tenant) => [
        {
          tenant_id: tenant,
          metric_date: "2026-11-10",
          crm_sent: 100,
          crm_clicks: 7,
          crm_direct_conversions: 2,
          crm_direct_revenue: "60.004",
        },
        {
          tenant_id: tenant,
          metric_date: "2026-11-11",
          crm_sent: 50,
          crm_clicks: 3,
          crm_direct_conversions: 1,
          crm_direct_revenue: 40,
        },
      ]),
      error: null,
    };
  });
  fake.admin.onRpc("finance_send_usage", (args) => {
    const tenants = args._tenants as string[];
    bulkCalls.push({ fn: "finance_send_usage", tenants });
    return {
      data: tenants.flatMap((tenant) => [
        {
          tenant_id: tenant,
          metric_date: "2026-11-10",
          item: "sms",
          units: 100,
          amount: "8.004",
          missing_cost_units: 0,
        },
        {
          tenant_id: tenant,
          metric_date: "2026-11-10",
          item: "email",
          units: 10,
          amount: 1,
          missing_cost_units: 0,
        },
      ]),
      error: null,
    };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("visao_geral", () => {
  it("queries only the houses resolverEscopoOps returns, and only through it", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, C], rotulo: "Todas as casas" });

    const result = await visaoGeral(identity, { escopo: { tipo: "todas" }, periodo: PERIODO }, NOW);

    expect(mocks.resolverEscopoOps).toHaveBeenCalledWith(USER, { tipo: "todas" });
    expect(dashboardCalls.map((call) => call._tenant).sort()).toEqual([HOUSE_A, HOUSE_C]);
    expect(lifecycleCalls.sort()).toEqual([HOUSE_A, HOUSE_C]);
    for (const call of bulkCalls) expect(call.tenants.sort()).toEqual([HOUSE_A, HOUSE_C]);
    expect(bulkCalls.map((call) => call.fn).sort()).toEqual([
      "finance_activity_days",
      "finance_send_usage",
    ]);
    expect(result.casas.map((row) => row.id)).toEqual([HOUSE_A, HOUSE_C]);
    expect(result.rotulo).toBe("Todas as casas");
  });

  it("propagates the gate's refusal without querying anything", async () => {
    mocks.resolverEscopoOps.mockRejectedValue(
      new Error("Você não tem acesso à operação desta casa."),
    );

    await expect(
      visaoGeral(identity, { escopo: { tipo: "casa", id: HOUSE_OTHER }, periodo: PERIODO }, NOW),
    ).rejects.toThrow("Você não tem acesso à operação desta casa.");
    expect(dashboardCalls).toEqual([]);
    expect(bulkCalls).toEqual([]);
  });

  it("one house matches the home: same RPC args as getDashboardSummary and mapDashboardRpc's numbers", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A], rotulo: "Casa A" });

    const result = await visaoGeral(
      identity,
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO },
      NOW,
    );

    // The home's PeriodPicker sends the period's first and last day; the
    // bounds (and so the RPC args) are the home's own computation.
    const bounds = dashboardPeriodBounds(
      "2026-11-10T03:00:00.000Z",
      "2026-11-16T03:00:00.000Z",
      NOW,
    );
    expect(dashboardCalls).toEqual([
      {
        _tenant: HOUSE_A,
        _from: bounds.startDate.toISOString(),
        _to: bounds.endDate.toISOString(),
        _prev_from: bounds.prevFrom,
        _prev_to: bounds.prevTo,
        _reset_at: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(bounds.periodDays).toBe(7);

    const mapped = mapDashboardRpc(payload(), bounds.periodDays);
    const [row] = result.casas;
    expect(row.atual).toEqual(kpisAtuais(mapped));
    expect(row.atual).toEqual({
      cadastros: mapped.newPlayers,
      ftds: mapped.ftd,
      depositos: mapped.depositCount,
      valor_depositado: 1500.56,
      depositantes: mapped.depositors,
      saques: mapped.withdrawalCount,
      valor_sacado: 400.1,
      ticket_medio: Math.round(mapped.ticket * 100) / 100,
    });
    expect(row.anterior).toBeUndefined();
    expect(row).toMatchObject({
      id: HOUSE_A,
      nome: "Casa A",
      moeda: "BRL",
      grupo: "Grupo Um",
      base_por_estado: { ativo: 5, esfriando: 0, dormindo: 0, perdido: 2, sem_ftd: 0 },
      crm: { enviados: 150, cliques: 10, conversoes_diretas: 3, receita_direta: 100 },
      custo_envios_brl: 9,
    });
    expect(result.periodo).toEqual({ inicio: "2026-11-10", fim: "2026-11-16", preset: "custom" });
    expect(result.casas_com_erro).toEqual([]);
    // No GGR/lucro, no SMS wallet fields of the home.
    expect(JSON.stringify(result)).not.toMatch(/ggr|lucro|walletBalance/i);
  });

  it("with comparar, sends that mode's window as the RPC's previous one and returns anterior", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A], rotulo: "Casa A" });

    const result = await visaoGeral(
      identity,
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO, comparar: "last_week" },
      NOW,
    );

    expect(dashboardCalls[0]._prev_from).toBe("2026-11-03T03:00:00.000Z");
    expect(dashboardCalls[0]._prev_to).toBe("2026-11-10T02:59:59.999Z");
    expect(result.periodo.comparacao).toEqual({
      inicio: "2026-11-03",
      fim: "2026-11-09",
      modo: "last_week",
    });
    expect(result.casas[0].anterior).toEqual({
      cadastros: 35,
      ftds: 6,
      depositos: 20,
      valor_depositado: 1000,
      depositantes: 10,
      saques: null,
      valor_sacado: 300,
      ticket_medio: 50,
    });
  });

  it("a failing house goes to casas_com_erro and the others come back", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, B], rotulo: "Grupo Um" });
    payloads.set(HOUSE_B, { error: "timeout na casa" });

    const result = await visaoGeral(
      identity,
      { escopo: { tipo: "grupo", id: GROUP }, periodo: PERIODO },
      NOW,
    );

    expect(result.casas.map((row) => row.id)).toEqual([HOUSE_A]);
    expect(result.casas_com_erro).toEqual([
      { id: HOUSE_B, nome: "Casa B", erro: "timeout na casa" },
    ]);
    expect(result.totais_por_moeda).toHaveLength(1);
    expect(result.totais_por_moeda[0].linhas).toBe(1);
  });

  it("fails when every house fails", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [B], rotulo: "Casa B" });
    payloads.set(HOUSE_B, { error: "fora do ar" });

    await expect(
      visaoGeral(identity, { escopo: { tipo: "casa", id: HOUSE_B }, periodo: PERIODO }, NOW),
    ).rejects.toThrow("Nenhuma casa respondeu. fora do ar");
  });

  it("two currencies give two totals, never a sum across them", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, B, C], rotulo: "Todas as casas" });

    const result = await visaoGeral(identity, { escopo: { tipo: "todas" }, periodo: PERIODO }, NOW);

    expect(result.totais_por_moeda.map((total) => total.moeda)).toEqual(["ARS", "BRL"]);
    const [ars, brl] = result.totais_por_moeda;
    expect(brl.linhas).toBe(2);
    expect(brl.totais.valor_depositado).toBe(2000.56);
    expect(brl.totais.depositos).toBe(40);
    expect(brl.totais.ticket_medio).toBe(50.01);
    expect(brl.totais.custo_envios_brl).toBe(18);
    expect(brl.totais.ativo).toBe(10);
    expect(ars.linhas).toBe(1);
    expect(ars.totais.valor_depositado).toBe(90000);
    expect(ars.totais.ticket_medio).toBe(30000);
  });

  it("a failing bulk CRM read leaves crm null with a notice instead of failing the houses", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A], rotulo: "Casa A" });
    fake.admin.onRpc("finance_activity_days", () => ({
      data: null,
      error: { message: "statement timeout" },
    }));

    const result = await visaoGeral(
      identity,
      { escopo: { tipo: "casa", id: HOUSE_A }, periodo: PERIODO },
      NOW,
    );

    expect(result.casas[0].crm).toBeNull();
    expect(result.casas[0].custo_envios_brl).toBe(9);
    expect(result.avisos).toEqual(["CRM do período indisponível: statement timeout"]);
  });

  it("output carries no player data", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, B, C], rotulo: "Todas as casas" });
    const result = await visaoGeral(
      identity,
      { escopo: { tipo: "todas" }, periodo: PERIODO, comparar: "previous" },
      NOW,
    );
    expect(() => assertSemDadosPessoais(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toContain("Fulano");
  });
});

// ─── comparar_casas ─────────────────────────────────────────────────────────

function seedComparison() {
  fake.admin.rows("crm_results_daily").push(
    {
      tenant_id: HOUSE_A,
      metric_date: "2026-11-10",
      source_type: "journey",
      source_key: "j1",
      source_id: null,
      step_position: 1,
      player_state: "ativo",
      sent: 100,
      failed: 0,
      cost: 8,
      recipients: 100,
      human_clicks: 10,
      converted_clicks: 2,
      direct_conversions: 2,
      direct_players: 2,
      direct_revenue: 50,
      influenced_players: 3,
      influenced_deposits: 3,
      influenced_revenue: 120,
    },
    {
      tenant_id: HOUSE_A,
      metric_date: "2026-11-12",
      source_type: "campaign",
      source_key: "c1",
      source_id: null,
      step_position: 0,
      player_state: "dormindo",
      sent: 100,
      failed: 0,
      cost: 8,
      recipients: 100,
      human_clicks: 0,
      direct_conversions: 0,
      direct_revenue: 0,
      influenced_players: 0,
      influenced_deposits: 0,
      influenced_revenue: 0,
    },
    // Outside the period: never counted.
    {
      tenant_id: HOUSE_A,
      metric_date: "2026-10-01",
      source_type: "journey",
      source_key: "j1",
      source_id: null,
      step_position: 1,
      player_state: "ativo",
      sent: 9999,
      failed: 0,
      cost: 999,
      recipients: 0,
      human_clicks: 0,
      direct_conversions: 0,
      direct_revenue: 0,
      influenced_players: 0,
      influenced_deposits: 0,
      influenced_revenue: 0,
    },
  );
  fake.admin.onRpc("crm_acquisition_funnel", (args) => ({
    data:
      args._tenant === HOUSE_A
        ? [
            { origin: "__total__", signups: 10, first_deposit: 4 },
            { origin: "organic", signups: 6, first_deposit: 1 },
          ]
        : [],
    error: null,
  }));
  fake.admin.onRpc("crm_retention_cohorts", (args) => ({
    data:
      args._tenant === HOUSE_A
        ? [
            { cohort_week: "2026-10-20", second_7d_pct: 25 },
            { cohort_week: "2026-11-10", second_7d_pct: 90 },
          ]
        : [],
    error: null,
  }));
  fake.admin.onRpc("crm_click_players_period", () => ({ data: null, error: null }));
}

describe("visao_geral_por_dia", () => {
  it("each day equals a one-day visao_geral (without the base), in one call", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, B], rotulo: "Grupo Um" });
    const periodo = { inicio: "2026-11-15", fim: "2026-11-16" };

    const porDia = await visaoGeralPorDia(identity, { escopo: { tipo: "grupo", id: GROUP }, periodo }, NOW);

    expect(porDia.rotulo).toBe("Grupo Um");
    expect(porDia.periodo).toEqual(periodo);
    expect(porDia.dias.map((dia) => dia.data)).toEqual(["2026-11-15", "2026-11-16"]);
    expect(porDia.dias_com_erro).toEqual([]);
    // The base by state is a snapshot of now: never read per day.
    expect(lifecycleCalls).toEqual([]);

    for (const dia of porDia.dias) {
      const umDia = await visaoGeral(
        identity,
        { escopo: { tipo: "grupo", id: GROUP }, periodo: { preset: "custom", inicio: dia.data, fim: dia.data } },
        NOW,
      );
      expect(dia.casas).toEqual(
        umDia.casas.map(({ grupo: _grupo, base_por_estado: _base, ...linha }) => linha),
      );
      expect(dia.casas.every((linha) => !("base_por_estado" in linha))).toBe(true);
    }
    assertSemDadosPessoais(porDia);
  });

  it("propagates the gate's refusal once, without querying anything", async () => {
    mocks.resolverEscopoOps.mockRejectedValue(
      new Error("Você não tem acesso à operação desta casa."),
    );
    await expect(
      visaoGeralPorDia(
        identity,
        { escopo: { tipo: "casa", id: HOUSE_OTHER }, periodo: { inicio: "2026-11-15", fim: "2026-11-16" } },
        NOW,
      ),
    ).rejects.toThrow("Você não tem acesso à operação desta casa.");
    expect(mocks.resolverEscopoOps).toHaveBeenCalledTimes(1);
    expect(dashboardCalls).toEqual([]);
  });
});

describe("comparar_casas", () => {
  beforeEach(seedComparison);

  it("queries only the resolved houses and maps the panel row to pt-BR", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, C], rotulo: "Todas as casas" });
    const funnelTenants: string[] = [];
    fake.admin.onRpc("crm_acquisition_funnel", (args) => {
      funnelTenants.push(String(args._tenant));
      return {
        data:
          args._tenant === HOUSE_A ? [{ origin: "__total__", signups: 10, first_deposit: 4 }] : [],
        error: null,
      };
    });

    const result = await compararCasas(
      identity,
      { escopo: { tipo: "todas" }, periodo: PERIODO },
      NOW,
    );

    expect(mocks.resolverEscopoOps).toHaveBeenCalledWith(USER, { tipo: "todas" });
    expect(funnelTenants.sort()).toEqual([HOUSE_A, HOUSE_C]);
    expect(lifecycleCalls.sort()).toEqual([HOUSE_A, HOUSE_C]);
    expect(result.casas[0]).toEqual({
      id: HOUSE_A,
      nome: "Casa A",
      moeda: "BRL",
      grupo: "Grupo Um",
      enviados: 200,
      custo_brl: 16,
      cliques: 10,
      taxa_clique_pct: 5,
      conversoes_diretas: 2,
      taxa_conversao_pct: 20,
      custo_por_conversao_brl: 8,
      roi_direto: 3.13,
      receita_direta: 50,
      jogadores_influenciados: 3,
      receita_influenciada: 120,
      custo_por_recuperado_brl: 5.33,
      roi: 7.5,
      custo_em_ativos_pct: 50,
      base_por_estado: { ativo: 5, esfriando: 0, dormindo: 0, perdido: 2, sem_ftd: 0 },
      cadastros: 10,
      cadastro_para_ftd_pct: 40,
      segundo_deposito_7d_pct: 25,
      semana_coorte: "2026-10-20",
    });
    expect(result.casas[1]).toMatchObject({ id: HOUSE_C, moeda: "ARS", enviados: 0, roi: null });
    expect(result.totais_por_moeda.map((total) => total.moeda)).toEqual(["ARS", "BRL"]);
    expect(result.totais_por_moeda[1].totais).toMatchObject({ enviados: 200, custo_brl: 16 });
    expect(() => assertSemDadosPessoais(result)).not.toThrow();
  });

  it("a failing house goes to casas_com_erro", async () => {
    mocks.resolverEscopoOps.mockResolvedValue({ casas: [A, B], rotulo: "Grupo Um" });
    fake.admin.failNext("crm_results_daily", "select");

    const result = await compararCasas(
      identity,
      { escopo: { tipo: "grupo", id: GROUP }, periodo: PERIODO },
      NOW,
    );

    expect(result.casas).toHaveLength(1);
    expect(result.casas_com_erro).toHaveLength(1);
    expect(result.casas_com_erro[0].erro).toBe(
      "Não foi possível carregar os resultados das casas.",
    );
  });
});

describe("VISAO_TOOLS", () => {
  it("registers visao_geral, visao_geral_por_dia and comparar_casas", () => {
    expect(VISAO_TOOLS.map((tool) => tool.name)).toEqual([
      "visao_geral",
      "visao_geral_por_dia",
      "comparar_casas",
    ]);
    for (const tool of VISAO_TOOLS) {
      expect(
        tool.inputSchema.safeParse({ escopo: { tipo: "todas" }, periodo: { preset: "7d" } })
          .success,
      ).toBe(true);
    }
  });
});
