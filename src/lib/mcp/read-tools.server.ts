// MCP financeiro, Task 6: read tools over the existing finance panel
// functions. Every tool maps its (pt-BR) args onto the same input schema the
// panel already validates with, then calls the existing `*For` core — the
// core's own permission check (`requirePermission`/`requireSuperAdmin`) is
// the only gate; this file never queries finance tables directly and never
// adds a parallel permission check that could diverge from the panel's.
// See docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §6.
import { z } from "zod";

import type { McpIdentity } from "./access.server";
import {
  dashboardInput,
  getFinanceDashboardFor,
  type DashboardScope,
} from "@/lib/finance-dashboard.functions";
import { presetRange } from "@/lib/finance/calc";
import { compareMode, isoDate, periodPreset } from "@/lib/finance/finance-data.server";
import { listFinanceScopesFor, type FinanceScopes } from "@/lib/finance/finance-scopes.server";
import {
  getTenantFinanceMonthFor,
  getTenantGoalsFor,
  monthInput,
  tenantIdInput,
} from "@/lib/finance.functions";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = { userId: string };
const ctxFor = (identity: McpIdentity): ServerContext => ({ userId: identity.userId });

// ─── listarEscopos ──────────────────────────────────────────────────────────

export type ListarEscoposResult = FinanceScopes & { nivel: "leitura" | "leitura e escrita" };

/** Scopes the caller may act on, plus their current MCP access level. */
export async function listarEscopos(identity: McpIdentity): Promise<ListarEscoposResult> {
  const scopes = await listFinanceScopesFor(identity.userId);
  return { ...scopes, nivel: identity.level === "write" ? "leitura e escrita" : "leitura" };
}

// ─── resumoFinanceiro ───────────────────────────────────────────────────────

const escopoInput = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("casa"), id: dbUuid() }),
  z.object({ tipo: z.literal("grupo"), id: dbUuid() }),
  z.object({ tipo: z.literal("todas") }),
]);

const periodoInput = z.object({
  preset: periodPreset.optional(),
  inicio: isoDate.optional(),
  fim: isoDate.optional(),
});

export const resumoFinanceiroInput = z.object({
  escopo: escopoInput,
  periodo: periodoInput,
  comparar: compareMode.optional(),
});

function toDashboardScope(escopo: z.infer<typeof escopoInput>): DashboardScope {
  switch (escopo.tipo) {
    case "casa":
      return { kind: "tenant", tenantId: escopo.id };
    case "grupo":
      return { kind: "group", groupId: escopo.id };
    case "todas":
      return { kind: "all" };
  }
}

/** The periodo's range and preset — "preset" (not "custom") maps through the
 * same `presetRange` the panel's period filter sends the server, so
 * `periodo.preset` always yields the same window. */
function toRangeAndPreset(periodo: z.infer<typeof periodoInput>, now: Date) {
  if (periodo.preset && periodo.preset !== "custom") {
    return { range: presetRange(periodo.preset, now), preset: periodo.preset };
  }
  if (!periodo.inicio || !periodo.fim) {
    throw new Error("Informe o período: preset, ou início e fim.");
  }
  return { range: { from: periodo.inicio, to: periodo.fim }, preset: "custom" as const };
}

export type ResumoFinanceiroResult = ReturnType<typeof shapeResumo>;

function shapeResumo(dashboard: Awaited<ReturnType<typeof getFinanceDashboardFor>>) {
  return {
    rotulo: dashboard.label,
    periodo: dashboard.range,
    comparar: dashboard.compareRange,
    totais: dashboard.totals,
    casas: dashboard.tenants.map((tenant) => ({
      id: tenant.id,
      nome: tenant.nome,
      atual: tenant.current,
      anterior: tenant.previous,
      metas: tenant.goals,
      pendentes: tenant.pendingDates,
    })),
  };
}

/**
 * Financial summary of a house, a group or every house (compact shape:
 * totals, one row per house, pending dates and goals — money already as
 * plain reais numbers). Permission is `getFinanceDashboardFor`'s own
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

// ─── mesDaCasa ──────────────────────────────────────────────────────────────

const mesDaCasaInput = z.object({ casa: dbUuid(), mes: z.string() });

/**
 * A house's financial month close, without `viewers` (gestores and their
 * e-mail) and without any other e-mail field — no player or user contact
 * data ever leaves the MCP read path. Permission is
 * `getTenantFinanceMonthFor`'s own (`finance_can_view`).
 */
export async function mesDaCasa(identity: McpIdentity, args: z.input<typeof mesDaCasaInput>) {
  const { casa, mes } = mesDaCasaInput.parse(args);
  const parsed = monthInput.parse({ tenantId: casa, month: mes });
  const result = await getTenantFinanceMonthFor(ctxFor(identity), parsed);
  const { viewers: _viewers, ...rest } = result;
  return rest;
}

// ─── metasDaCasa ────────────────────────────────────────────────────────────

const metasDaCasaInput = z.object({ casa: dbUuid() });

/** The goal in force today for every metric of a house. */
export async function metasDaCasa(identity: McpIdentity, args: z.input<typeof metasDaCasaInput>) {
  const { casa } = metasDaCasaInput.parse(args);
  const parsed = tenantIdInput.parse({ tenantId: casa });
  return getTenantGoalsFor(ctxFor(identity), parsed);
}
