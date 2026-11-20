// MCP financeiro, Task 6: read tools over the existing finance panel
// functions. Every tool maps its (pt-BR) args onto the same input schema the
// panel already validates with, then calls the existing `*For` core — the
// core's own permission check (`requirePermission`/`requireSuperAdmin`) is
// the only gate; this file never queries finance tables directly and never
// adds a parallel permission check that could diverge from the panel's.
// See docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §6.
import { z } from "zod";

import type { McpArea, McpIdentity } from "./access.server";
import {
  dashboardInput,
  getFinanceDashboardFor,
  type DashboardScope,
} from "@/lib/finance-dashboard.functions";
import { compareMode } from "@/lib/finance/finance-data.server";
import { listFinanceScopesFor, type FinanceScopes } from "@/lib/finance/finance-scopes.server";
import {
  getTenantFinanceMonthFor,
  getTenantGoalsFor,
  monthInput,
  tenantIdInput,
} from "@/lib/finance.functions";
import { dbUuid } from "@/lib/zod-helpers";

import { escopoInput, periodoInput, toRangeAndPreset } from "./inputs.server";
import { listarEscoposOps, type EscoposOps } from "./ops/scope.server";
import { diasDe, periodoPorDiaInput, porDia } from "./por-dia.server";

type ServerContext = { userId: string };
const ctxFor = (identity: McpIdentity): ServerContext => ({ userId: identity.userId });

// ─── listarEscopos ──────────────────────────────────────────────────────────

export type ListarEscoposResult = Partial<FinanceScopes> & {
  nivel: "leitura" | "leitura e escrita";
  areas: McpArea[];
  operacao?: EscoposOps;
};

/**
 * Scopes the caller may act on, plus their current MCP access level and
 * areas. The finance scopes (superAdmin, houses, groups) come only with the
 * `financeiro` area, and `operacao` (houses and groups for the operação
 * tools, spec 2026-11-17 §5.1) only with the `operacao` area — list-only:
 * every tool re-checks permission itself.
 */
export async function listarEscopos(identity: McpIdentity): Promise<ListarEscoposResult> {
  const hasFinance = identity.areas.includes("financeiro");
  const hasOps = identity.areas.includes("operacao");
  const [scopes, operacao] = await Promise.all([
    hasFinance ? listFinanceScopesFor(identity.userId) : null,
    hasOps ? listarEscoposOps(identity.userId) : null,
  ]);
  return {
    ...(scopes ?? {}),
    nivel: identity.level === "write" ? "leitura e escrita" : "leitura",
    areas: identity.areas,
    ...(operacao ? { operacao } : {}),
  };
}

// ─── resumoFinanceiro ───────────────────────────────────────────────────────

export const resumoFinanceiroInput = z.object({
  escopo: escopoInput,
  periodo: periodoInput,
  comparar: compareMode.optional(),
});

export function toDashboardScope(escopo: z.infer<typeof escopoInput>): DashboardScope {
  switch (escopo.tipo) {
    case "casa":
      return { kind: "tenant", tenantId: escopo.id };
    case "grupo":
      return { kind: "group", groupId: escopo.id };
    case "todas":
      return { kind: "all" };
  }
}

export type ResumoFinanceiroResult = ReturnType<typeof shapeResumo>;

/**
 * Moeda: cada casa traz `moeda` (seus valores estão nela; envios e
 * mensalidade são BRL, e fora do BRL o lucro líquido/ROI vêm null, sem
 * câmbio). `moeda` do resumo é a única das casas, ou null quando há mais de
 * uma: aí `totais`/`kpis` vêm null (nunca uma soma entre moedas) e
 * `totais_por_moeda` traz um total por moeda.
 */
function shapeResumo(dashboard: Awaited<ReturnType<typeof getFinanceDashboardFor>>) {
  const mixed = dashboard.currency === null;
  return {
    rotulo: dashboard.label,
    periodo: dashboard.range,
    comparar: dashboard.compareRange,
    moeda: dashboard.currency,
    totais: mixed ? null : dashboard.totals,
    totais_por_moeda: dashboard.currencyTotals.map((total) => ({
      moeda: total.currency,
      casas: total.houses,
      atual: total.current,
      anterior: total.previous,
    })),
    moeda_custos_betleads: "BRL" as const,
    kpis: mixed ? null : dashboard.kpis,
    casas: dashboard.tenants.map((tenant) => ({
      id: tenant.id,
      nome: tenant.nome,
      moeda: tenant.moeda,
      atual: tenant.current,
      anterior: tenant.previous,
      metas: tenant.goals,
      pendentes: tenant.pendingDates,
    })),
  };
}

/**
 * Financial summary of a house, a group or every house (spec §6 item 2:
 * totals, per-house rows, KPIs, pending dates and goals — money as plain
 * numbers in each house's `moeda`, Betleads costs in BRL; see shapeResumo). Permission is `getFinanceDashboardFor`'s own
 * (`finance_can_view` for a house, group management for a group, super admin
 * for "todas"); this function never pre-checks it itself.
 */
export async function resumoFinanceiro(
  identity: McpIdentity,
  args: z.input<typeof resumoFinanceiroInput>,
): Promise<ResumoFinanceiroResult> {
  const data = resumoFinanceiroInput.parse(args);
  const { range, preset } = toRangeAndPreset(data.periodo, new Date());
  const input = dashboardInput.parse({
    scope: toDashboardScope(data.escopo),
    range,
    preset,
    compare: data.comparar ?? "none",
  });
  const dashboard = await getFinanceDashboardFor(ctxFor(identity), input);
  return shapeResumo(dashboard);
}

// ─── resumoPorDia ───────────────────────────────────────────────────────────

export const resumoPorDiaInput = z.object({
  escopo: escopoInput,
  periodo: periodoPorDiaInput,
});

/**
 * resumo_financeiro broken down by day in one call: each day is exactly a
 * one-day resumo_financeiro (same permission, same numbers as the panel with
 * that single day selected), trimmed to the totals and each house's `atual`
 * (no comparison, goals or pending dates per day).
 */
export async function resumoPorDia(
  identity: McpIdentity,
  args: z.input<typeof resumoPorDiaInput>,
  now: Date = new Date(),
) {
  const data = resumoPorDiaInput.parse(args);
  const dias = diasDe(data.periodo, now);
  let rotulo = "";
  let moeda = null as ResumoFinanceiroResult["moeda"];
  const resultado = await porDia(dias, async (dia) => {
    const resumo = await resumoFinanceiro(identity, {
      escopo: data.escopo,
      periodo: { preset: "custom", inicio: dia, fim: dia },
      comparar: "none",
    });
    rotulo = resumo.rotulo;
    moeda = resumo.moeda;
    return {
      totais: resumo.totais ? resumo.totais.current : null,
      totais_por_moeda: resumo.totais_por_moeda.map((total) => ({
        moeda: total.moeda,
        casas: total.casas,
        atual: total.atual,
      })),
      casas: resumo.casas.map((casa) => ({
        id: casa.id,
        nome: casa.nome,
        moeda: casa.moeda,
        atual: casa.atual,
      })),
    };
  });
  return {
    rotulo,
    periodo: { inicio: dias[0], fim: dias[dias.length - 1] },
    moeda,
    moeda_custos_betleads: "BRL" as const,
    ...resultado,
  };
}

// ─── mesDaCasa ──────────────────────────────────────────────────────────────

export const mesDaCasaInput = z.object({ casa: dbUuid(), mes: z.string() });

/**
 * A house's financial month close, without `viewers` (gestores and their
 * e-mail) and without any other e-mail field — no player or user contact
 * data ever leaves the MCP read path. Permission is
 * `getTenantFinanceMonthFor`'s own (`finance_can_view`).
 */
// O resultado traz `moeda` (a da casa): dias, GGR, anúncios e custos nela;
// envios e mensalidade em BRL; fora do BRL summary.cashResult/roi vêm null.
export async function mesDaCasa(identity: McpIdentity, args: z.input<typeof mesDaCasaInput>) {
  const { casa, mes } = mesDaCasaInput.parse(args);
  const parsed = monthInput.parse({ tenantId: casa, month: mes });
  const result = await getTenantFinanceMonthFor(ctxFor(identity), parsed);
  const { viewers: _viewers, ...rest } = result;
  return rest;
}

// ─── metasDaCasa ────────────────────────────────────────────────────────────

export const metasDaCasaInput = z.object({ casa: dbUuid() });

/** The goal in force today for every metric of a house. */
export async function metasDaCasa(identity: McpIdentity, args: z.input<typeof metasDaCasaInput>) {
  const { casa } = metasDaCasaInput.parse(args);
  const parsed = tenantIdInput.parse({ tenantId: casa });
  return getTenantGoalsFor(ctxFor(identity), parsed);
}
