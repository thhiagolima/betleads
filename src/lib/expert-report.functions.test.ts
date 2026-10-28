// Relatório de rendimento — server functions (spec §4, §6, §7). Os guards
// reais rodam sobre o banco em memória (`createFakeDb`); as funções SQL são
// simuladas com `onRpc`, e `expert_report`/`expert_portfolio` somam os
// créditos em memória para checar que os totais batem com o extrato.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return {
    supabaseAdmin: {
      ...fake.admin.client,
      // Only `getTeamReportFor` (via `listExpertsFor`) reads auth users, for
      // the one linked expert (ME/EXPERT_USER); unlinked profiles (OTHER)
      // never call this.
      auth: {
        admin: {
          getUserById: async (id: string) =>
            id === EXPERT_USER
              ? { data: { user: { id, email: "ana@casa.com", last_sign_in_at: null } }, error: null }
              : { data: { user: null }, error: { message: "User not found" } },
        },
      },
    },
  };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { listExpertCreditsFor } from "@/lib/expert-metrics.functions";
import { __resetDemoTenantCacheForTests } from "@/lib/tenant-access.server";
import type { ServerContext } from "./expert-report-subject.server";
import {
  exportExpertPortfolioCsvFor,
  exportTeamReportCsvFor,
  getExpertLeadTimelineFor,
  getExpertReportFor,
  getTeamReportFor,
  listExpertPortfolioFor,
} from "./expert-report.functions";

const TENANT = "00000000-0000-4000-8000-00000000a0a0";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const EXPERT_USER = "00000000-0000-4000-8000-0000000000a5";
const ME = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";
const PLAYER = "00000000-0000-4000-8000-0000000000b1";
const PLAYER_2 = "00000000-0000-4000-8000-0000000000b2";

// 24/10/2026 09:00 em São Paulo. "Este mês": [01/10 00:00 SP, agora);
// anterior: [01/09 00:00 SP, 24/09 09:00 SP).
const NOW = "2026-10-24T12:00:00.000Z";
const CURRENT_FROM = "2026-10-01T03:00:00.000Z";
const PREVIOUS_FROM = "2026-09-01T03:00:00.000Z";
const PREVIOUS_TO = "2026-09-24T12:00:00.000Z";

function ctxFor(userId: string, opts: { admin?: boolean } = {}): ServerContext {
  return {
    userId,
    activeTenantId: TENANT,
    supabase: {
      rpc: async (name: string) => {
        if (name === "is_super_admin") return { data: false, error: null };
        if (name === "current_tenant_id") return { data: TENANT, error: null };
        if (name === "is_tenant_admin") return { data: opts.admin ?? false, error: null };
        return { data: null, error: null };
      },
    },
  };
}

function addCredit(id: string, overrides: Record<string, unknown> = {}) {
  fake.admin.rows("expert_deposit_credits").push({
    deposit_id: id,
    tenant_id: TENANT,
    player_id: PLAYER,
    expert_id: ME,
    via: "clique",
    valor: 10,
    deposit_at: "2026-10-20T15:00:00Z",
    link_dispatch_id: null,
    click_at: null,
    is_ftd: false,
    is_reativacao: false,
    computed_at: "2026-10-24T11:50:00Z",
    ...overrides,
  });
}

type Credit = {
  tenant_id: string;
  expert_id: string;
  player_id: string;
  valor: number;
  via: string;
  deposit_at: string;
  is_ftd: boolean;
  is_reativacao: boolean;
};

function creditsIn(args: Record<string, unknown>): Credit[] {
  return (fake.admin.rows("expert_deposit_credits") as unknown as Credit[]).filter(
    (c) =>
      c.tenant_id === args._tenant &&
      c.expert_id === args._expert &&
      new Date(c.deposit_at) >= new Date(String(args._from)) &&
      new Date(c.deposit_at) < new Date(String(args._to)),
  );
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    depositado: 0,
    depositado_clique: 0,
    depositado_afiliado: 0,
    ftds: 0,
    valor_ftd: 0,
    redepositos: 0,
    valor_redeposito: 0,
    reativados: 0,
    depositantes: 0,
    links: 0,
    leads_com_link: 0,
    leads_clicaram: 0,
    leads_depositaram_clique: 0,
    contatos: 0,
    ...overrides,
  };
}

/** In-memory `expert_report` over the fake credits (the credit part only). */
function installReportFromCredits() {
  fake.admin.onRpc("expert_report", (args) => {
    const cs = creditsIn(args);
    const sum = (xs: Credit[]) => xs.reduce((s, c) => s + Number(c.valor), 0);
    const redeps = cs.filter((c) => !c.is_ftd);
    return {
      data: [
        reportRow({
          depositado: String(sum(cs)),
          depositado_clique: sum(cs.filter((c) => c.via === "clique")),
          depositado_afiliado: sum(cs.filter((c) => c.via === "afiliado")),
          ftds: cs.filter((c) => c.is_ftd).length,
          valor_ftd: sum(cs.filter((c) => c.is_ftd)),
          redepositos: redeps.length,
          valor_redeposito: sum(redeps),
          reativados: cs.filter((c) => c.is_reativacao).length,
          depositantes: new Set(cs.map((c) => c.player_id)).size,
        }),
      ],
      error: null,
    };
  });
}

/** In-memory `expert_portfolio` over the fake credits (no search/filters). */
function installPortfolioFromCredits() {
  fake.admin.onRpc("expert_portfolio", (args) => {
    const byPlayer = new Map<string, Credit[]>();
    for (const c of creditsIn(args)) {
      byPlayer.set(c.player_id, [...(byPlayer.get(c.player_id) ?? []), c]);
    }
    const all = [...byPlayer.entries()]
      .map(([playerId, cs]) => ({
        player_id: playerId,
        nome: `Lead ${playerId.slice(-2)}`,
        telefone: null,
        creditado: cs.reduce((s, c) => s + Number(c.valor), 0),
        depositos: cs.length,
        origem: "clique",
        primeiro_credito: cs[0].deposit_at,
        ultimo_deposito: null,
        ultimo_contato_resultado: null,
        ultimo_contato_em: null,
        tem_ftd: cs.some((c) => c.is_ftd),
        reativado: cs.some((c) => c.is_reativacao),
      }))
      .sort((a, b) => b.creditado - a.creditado);
    const offset = Number(args._offset);
    return {
      data: all
        .slice(offset, offset + Number(args._limit))
        .map((r) => ({ ...r, total_count: all.length })),
      error: null,
    };
  });
}

beforeEach(async () => {
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  __resetDemoTenantCacheForTests();
  vi.setSystemTime(new Date(NOW));
  fake.admin.rows("tenants").push({ id: TENANT, nome: "Casa", status: "active", is_demo: false });
  fake.admin
    .rows("user_roles")
    .push(
      { id: "r-admin", user_id: ADMIN, tenant_id: TENANT, role: "admin" },
      { id: "r-expert", user_id: EXPERT_USER, tenant_id: TENANT, role: "expert" },
    );
  for (const [id, nome, userId] of [
    [ME, "Ana Souza", EXPERT_USER],
    [OTHER, "Bruno", null],
  ] as const) {
    fake.admin.rows("experts").push({
      id,
      tenant_id: TENANT,
      nome,
      tipo: "total",
      ativo: true,
      envio_modo: "livre",
      teto_mensal: null,
      assumir_prazo_dias: 3,
      user_id: userId,
      ja_vinculado: false,
      created_at: "2026-01-01T00:00:00Z",
    });
  }
  fake.admin
    .rows("players")
    .push(
      { id: PLAYER, tenant_id: TENANT, nome: "Jogador 1" },
      { id: PLAYER_2, tenant_id: TENANT, nome: "Jogador 2" },
    );
  fake.admin.onRpc("expert_report", () => ({ data: [reportRow()], error: null }));
  fake.admin.onRpc("expert_report_daily", () => ({ data: [], error: null }));
  fake.admin.onRpc("expert_portfolio", () => ({ data: [], error: null }));
  fake.admin.onRpc("expert_last_computed_at", () => ({ data: null, error: null }));
  fake.admin.onRpc("expert_team_report", () => ({ data: [], error: null }));
  fake.admin.onRpc("house_deposit_totals", () => ({
    data: [{ depositado: 0, ftds: 0 }],
    error: null,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getExpertReportFor", () => {
  it("report maps both periods, computes variation via variationPct and ticket = valorRedeposito/redepositos", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fake.admin.onRpc("expert_report", (args) => {
      calls.push(args);
      const current = args._from === CURRENT_FROM;
      return {
        data: [
          current
            ? reportRow({
                depositado: "300.00",
                depositado_clique: "200",
                depositado_afiliado: "100",
                ftds: 3,
                valor_ftd: "90",
                redepositos: 4,
                valor_redeposito: "210",
                reativados: 1,
                depositantes: 5,
                links: 7,
                leads_com_link: 6,
                leads_clicaram: 4,
                leads_depositaram_clique: 2,
                contatos: 9,
              })
            : reportRow({
                depositado: "200",
                ftds: 0,
                redepositos: 5,
                valor_redeposito: 200,
                reativados: 2,
              }),
        ],
        error: null,
      };
    });
    fake.admin.onRpc("expert_report_daily", (args) => {
      expect(args).toMatchObject({ _tenant: TENANT, _expert: ME, _from: CURRENT_FROM, _to: NOW });
      return {
        data: [{ dia: "2026-10-01", valor_ftd: "30", valor_redeposito: 0, depositantes: 1 }],
        error: null,
      };
    });
    fake.admin.onRpc("expert_last_computed_at", () => ({
      data: "2026-10-24T11:50:00+00:00",
      error: null,
    }));
    fake.admin.rows("expert_settings").push({ tenant_id: TENANT, click_window_hours: 48 });

    const result = await getExpertReportFor(ctxFor(EXPERT_USER), { period: "mes_atual" });

    expect(calls).toEqual(
      expect.arrayContaining([
        { _tenant: TENANT, _expert: ME, _from: CURRENT_FROM, _to: NOW },
        { _tenant: TENANT, _expert: ME, _from: PREVIOUS_FROM, _to: PREVIOUS_TO },
      ]),
    );
    expect(result.subject).toMatchObject({
      expertId: ME,
      viewer: "self",
      tipoLabel: "Expert total",
    });
    expect(result.current).toEqual({
      depositado: 300,
      depositadoClique: 200,
      depositadoAfiliado: 100,
      ftds: 3,
      valorFtd: 90,
      redepositos: 4,
      valorRedeposito: 210,
      ticketRedeposito: 52.5,
      reativados: 1,
      depositantes: 5,
      links: 7,
      leadsComLink: 6,
      leadsClicaram: 4,
      leadsDepositaramClique: 2,
      contatos: 9,
    });
    expect(result.previous).toMatchObject({
      depositado: 200,
      redepositos: 5,
      ticketRedeposito: 40,
    });
    expect(result.variacao).toEqual({
      depositado: 50,
      ftds: null, // sem base no período anterior
      redepositos: -20,
      reativados: -50,
    });
    expect(result.serie).toEqual([
      { dia: "2026-10-01", valorFtd: 30, valorRedeposito: 0, depositantes: 1 },
    ]);
    expect(result.janelaHoras).toBe(48);
    expect(result.atualizadoEm).toBe("2026-10-24T11:50:00+00:00");

    // Sem redepósitos: ticket nulo, não divisão por zero.
    fake.admin.onRpc("expert_report", () => ({ data: [reportRow()], error: null }));
    const empty = await getExpertReportFor(ctxFor(EXPERT_USER), { period: "mes_atual" });
    expect(empty.current.ticketRedeposito).toBeNull();
    expect(empty.atualizadoEm).toBe("2026-10-24T11:50:00+00:00");
  });

  it("report total equals listExpertCredits somaValor for the same subject and period", async () => {
    installReportFromCredits();
    installPortfolioFromCredits();
    addCredit("d-1", { valor: 100.1, is_ftd: true });
    addCredit("d-2", { valor: 20.2, via: "afiliado", player_id: PLAYER_2 });
    addCredit("d-3", { valor: 3.3, deposit_at: "2026-10-01T03:00:00Z" }); // 1º dia, 00:00 SP
    addCredit("d-sep", { valor: 999, deposit_at: "2026-09-30T23:00:00Z" }); // mês anterior
    addCredit("d-other", { valor: 555, expert_id: OTHER });

    for (const [ctx, expertId] of [
      [ctxFor(EXPERT_USER), undefined],
      [ctxFor(ADMIN, { admin: true }), ME],
    ] as const) {
      const report = await getExpertReportFor(ctx, { period: "mes_atual", expertId });
      const statement = await listExpertCreditsFor(ctx, { period: "mes_atual", expertId });
      const portfolio = await listExpertPortfolioFor(ctx, {
        period: "mes_atual",
        expertId,
        page: 0,
      });

      expect(report.current.depositado).toBeCloseTo(123.6, 6);
      expect(statement.somaValor).toBeCloseTo(report.current.depositado, 6);
      expect(portfolio.rows.reduce((s, r) => s + r.creditado, 0)).toBeCloseTo(
        report.current.depositado,
        6,
      );
      expect(report.topLeads.map((r) => r.playerId)).toEqual([PLAYER, PLAYER_2]);
    }
  });

  it("refuses expertId from a non-admin", async () => {
    await expect(
      getExpertReportFor(ctxFor(EXPERT_USER), { period: "mes_atual", expertId: OTHER }),
    ).rejects.toThrow("Apenas o admin da casa gerencia experts.");
  });
});

describe("listExpertPortfolioFor / exportExpertPortfolioCsvFor", () => {
  function portfolioRow(overrides: Record<string, unknown> = {}) {
    return {
      player_id: PLAYER,
      nome: "Jogador 1",
      telefone: "5511999990000",
      creditado: "1234.5",
      depositos: 3,
      origem: "ambos",
      primeiro_credito: "2026-09-10T15:30:00Z", // 12:30 SP
      ultimo_deposito: "2026-10-20T13:00:00Z", // 10:00 SP
      ultimo_contato_resultado: "prometeu_depositar",
      ultimo_contato_em: "2026-10-19T21:15:00Z", // 18:15 SP
      tem_ftd: true,
      reativado: false,
      total_count: 120,
      ...overrides,
    };
  }

  it("portfolio passes filters and pages of 50, mapping rows", async () => {
    const seen: Array<Record<string, unknown>> = [];
    fake.admin.onRpc("expert_portfolio", (args) => {
      seen.push(args);
      return { data: [portfolioRow()], error: null };
    });

    const result = await listExpertPortfolioFor(ctxFor(EXPERT_USER), {
      period: "mes_atual",
      search: "  joga ",
      onlyFtd: true,
      page: 2,
    });

    expect(seen[0]).toEqual({
      _tenant: TENANT,
      _expert: ME,
      _from: CURRENT_FROM,
      _to: NOW,
      _search: "joga",
      _only_ftd: true,
      _only_reativados: false,
      _limit: 50,
      _offset: 100,
    });
    expect(result).toEqual({
      total: 120,
      rows: [
        {
          playerId: PLAYER,
          nome: "Jogador 1",
          telefone: "5511999990000",
          creditado: 1234.5,
          depositos: 3,
          origem: "ambos",
          primeiroCredito: "2026-09-10T15:30:00Z",
          ultimoDeposito: "2026-10-20T13:00:00Z",
          ultimoContato: { resultado: "prometeu_depositar", em: "2026-10-19T21:15:00Z" },
          temFtd: true,
          reativado: false,
        },
      ],
    });
    await expect(
      listExpertPortfolioFor(ctxFor(EXPERT_USER), {
        period: "mes_atual",
        search: "x".repeat(81),
        page: 0,
      }),
    ).rejects.toThrow();
  });

  it("portfolio csv has the exact header and escapes", async () => {
    fake.admin.onRpc("expert_portfolio", () => ({
      data: [
        portfolioRow(),
        portfolioRow({
          player_id: PLAYER_2,
          nome: 'Lead "Esperto"; Silva',
          telefone: "=1+2",
          creditado: 10,
          depositos: 1,
          origem: "afiliado",
          primeiro_credito: "2026-10-02T03:00:00Z",
          ultimo_deposito: null,
          ultimo_contato_resultado: null,
          ultimo_contato_em: null,
          tem_ftd: false,
          reativado: true,
        }),
      ],
      error: null,
    }));

    const result = await exportExpertPortfolioCsvFor(ctxFor(EXPERT_USER), { period: "mes_atual" });

    expect(result.csv.startsWith("﻿")).toBe(true);
    const lines = result.csv.slice(1).split("\n");
    expect(lines[0]).toBe(
      "Lead;Telefone;Creditado;Depósitos;Origem;1º crédito;Último depósito;Último contato;FTD;Reativado",
    );
    expect(lines[1]).toBe(
      "Jogador 1;5511999990000;1234,50;3;Ambos;10/09/2026 12:30;20/10/2026 10:00;Prometeu depositar em 19/10/2026 18:15;Sim;Não",
    );
    expect(lines[2]).toBe(
      `"Lead ""Esperto""; Silva";'=1+2;10,00;1;Afiliado;02/10/2026 00:00;;;Não;Sim`,
    );
    expect(lines[3]).toBe("Total;;1244,50;4;;;;;;");
    expect(result.filename).toBe("carteira-ana-souza-2026-10-01-a-2026-10-24.csv");
  });
});

describe("getExpertLeadTimelineFor", () => {
  function item(i: number) {
    return {
      at: new Date(Date.parse("2026-10-20T00:00:00Z") - i * 60_000).toISOString(),
      kind: "deposito",
      titulo: "Depósito aprovado",
      detalhe: "afiliado",
      valor: "15.5",
      status: "creditado",
    };
  }

  it("timeline returns nextBefore when 100 items came back", async () => {
    addCredit("d-1", { valor: 15.5, deposit_at: "2026-03-01T12:00:00Z" });
    addCredit("d-2", { valor: 4.5, deposit_at: "2026-10-19T12:00:00Z" });
    addCredit("d-other-lead", { valor: 99, player_id: PLAYER_2 });
    addCredit("d-other-expert", {
      valor: 99,
      expert_id: OTHER,
      deposit_at: "2026-01-01T00:00:00Z",
    });

    const seen: Array<Record<string, unknown>> = [];
    let count = 100;
    fake.admin.onRpc("expert_lead_timeline", (args) => {
      seen.push(args);
      return { data: Array.from({ length: count }, (_, i) => item(i)), error: null };
    });

    const full = await getExpertLeadTimelineFor(ctxFor(EXPERT_USER), { playerId: PLAYER });
    expect(seen[0]).toEqual({
      _tenant: TENANT,
      _expert: ME,
      _player: PLAYER,
      _before: null,
      _limit: 100,
    });
    expect(full.items).toHaveLength(100);
    expect(full.items[0]).toEqual({
      at: item(0).at,
      kind: "deposito",
      titulo: "Depósito aprovado",
      detalhe: "afiliado",
      valor: 15.5,
      status: "creditado",
    });
    expect(full.nextBefore).toBe(item(99).at);
    // Resumo: todo o histórico da pessoa com o lead, não só o período.
    expect(full.resumo).toEqual({ creditado: 20, depositos: 2, desde: "2026-03-01T12:00:00Z" });

    // Empates em `at` (WITH TIES) podem trazer mais que o limite.
    count = 103;
    const ties = await getExpertLeadTimelineFor(ctxFor(EXPERT_USER), {
      playerId: PLAYER,
      before: full.nextBefore!,
    });
    expect(seen[1]._before).toBe(full.nextBefore);
    expect(ties.nextBefore).toBe(item(102).at);

    count = 99;
    const last = await getExpertLeadTimelineFor(ctxFor(EXPERT_USER), { playerId: PLAYER });
    expect(last.nextBefore).toBeNull();
  });

  it("admin reads another profile's timeline only through expertId", async () => {
    fake.admin.onRpc("expert_lead_timeline", (args) => {
      expect(args._expert).toBe(OTHER);
      return { data: [], error: null };
    });
    const result = await getExpertLeadTimelineFor(ctxFor(ADMIN, { admin: true }), {
      playerId: PLAYER,
      expertId: OTHER,
    });
    expect(result).toEqual({
      resumo: { creditado: 0, depositos: 0, desde: null },
      items: [],
      nextBefore: null,
    });

    await expect(
      getExpertLeadTimelineFor(ctxFor(EXPERT_USER), { playerId: PLAYER, expertId: OTHER }),
    ).rejects.toThrow("Apenas o admin da casa gerencia experts.");
  });
});

describe("getTeamReportFor / exportTeamReportCsvFor", () => {
  function teamRow(overrides: Record<string, unknown> = {}) {
    return {
      expert_id: ME,
      depositado: 0,
      ftds: 0,
      redepositos: 0,
      reativados: 0,
      leads_clicaram: 0,
      leads_depositaram_clique: 0,
      depositos: 0,
      ...overrides,
    };
  }

  it("team report refuses non-admin", async () => {
    await expect(
      getTeamReportFor(ctxFor(EXPERT_USER), { period: "mes_atual" }),
    ).rejects.toThrow("Apenas o admin da casa gerencia experts.");
  });

  it("team report computes house shares and handles zero house totals", async () => {
    fake.admin.onRpc("expert_team_report", (args) => {
      const current = args._from === CURRENT_FROM;
      return {
        data: [
          teamRow(
            current
              ? {
                  depositado: "300",
                  ftds: 3,
                  redepositos: 2,
                  reativados: 1,
                  leads_clicaram: 10,
                  leads_depositaram_clique: 4,
                  depositos: 6,
                }
              : { depositado: "100", ftds: 1, redepositos: 5 },
          ),
          teamRow({ expert_id: OTHER }),
        ],
        error: null,
      };
    });
    fake.admin.onRpc("house_deposit_totals", () => ({
      data: [{ depositado: "0", ftds: 0 }],
      error: null,
    }));

    const zeroHouse = await getTeamReportFor(ctxFor(ADMIN, { admin: true }), {
      period: "mes_atual",
    });

    expect(zeroHouse.totais).toEqual({
      creditado: 300,
      pctCasaDepositado: null, // casa sem depósito: sem divisão por zero
      ftds: 3,
      pctCasaFtds: null,
      redepositos: 2,
      reativados: 1,
    });
    // Ordenado por creditado desc.
    expect(zeroHouse.rows.map((r) => r.expertId)).toEqual([ME, OTHER]);
    expect(zeroHouse.rows[0]).toMatchObject({
      expertId: ME,
      nome: "Ana Souza",
      tipoLabel: "Expert total",
      ativo: true,
      creditado: 300,
      variacao: 200, // (300-100)/100 * 100
      ftds: 3,
      redepositos: 2,
      reativados: 1,
      cliqueDeposito: 0.4, // 4/10
      ticket: 50, // 300/6
    });
    expect(zeroHouse.rows[1]).toMatchObject({
      expertId: OTHER,
      nome: "Bruno",
      creditado: 0,
      variacao: null, // sem base (0 nos dois períodos)
      cliqueDeposito: null, // sem cliques
      ticket: null, // sem depósito
    });

    fake.admin.onRpc("house_deposit_totals", () => ({
      data: [{ depositado: "1000", ftds: 10 }],
      error: null,
    }));
    const withHouse = await getTeamReportFor(ctxFor(ADMIN, { admin: true }), {
      period: "mes_atual",
    });
    expect(withHouse.totais.pctCasaDepositado).toBeCloseTo(0.3, 6);
    expect(withHouse.totais.pctCasaFtds).toBeCloseTo(0.3, 6);
  });

  it("team csv header is exact", async () => {
    fake.admin.onRpc("expert_team_report", () => ({
      data: [
        teamRow({
          depositado: "123.40",
          ftds: 1,
          redepositos: 2,
          leads_clicaram: 4,
          leads_depositaram_clique: 2,
          depositos: 3,
        }),
      ],
      error: null,
    }));

    const result = await exportTeamReportCsvFor(ctxFor(ADMIN, { admin: true }), {
      period: "mes_atual",
    });

    expect(result.csv.startsWith("﻿")).toBe(true);
    const lines = result.csv.slice(1).split("\n");
    expect(lines[0]).toBe(
      "Pessoa;Tipo;Creditado;Variação;FTD;Redepósitos;Reativados;Clique→depósito;Ticket médio",
    );
    expect(lines[1]).toBe("Ana Souza;Expert total;123,40;0,0%;1;2;0;50,0%;41,13");
    expect(result.filename).toBe("equipe-2026-10-01-a-2026-10-24.csv");
  });
});
