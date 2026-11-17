// MCP do grupo, área de operação: visao_geral and comparar_casas (§5.2, §5.3
// of docs/superpowers/specs/2026-11-17-mcp-grupo-design.md). Contract in
// ./registry.server.ts: every tool resolves its houses through
// resolverEscopoOps (the only permission gate) and returns only aggregates.
//
// - visao_geral: the home KPIs per house, read through the very same
//   `fetchDashboardSummaryRpc` + `mapDashboardRpc` the home uses (same
//   dates, same `_reset_at`); plus the base by state (a snapshot of now), the
//   CRM of the period (`finance_activity_days`) and the send cost in BRL
//   (`finance_send_usage`). No GGR/lucro: those belong to `resumo_financeiro`.
// - comparar_casas: the "Comparar casas" screen's rows
//   (`getTenantComparisonRow`), one house at a time so a failing house only
//   lands in `casas_com_erro`.
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DASHBOARD_REQUEST_TIMEOUT_MS,
  dashboardPeriodBounds,
  fetchDashboardSummaryRpc,
  mapDashboardRpc,
  withTimeout,
  type DashboardDb,
  type DashboardRpc,
} from "@/lib/dashboard.functions";
import { compareRange } from "@/lib/finance/calc";
import {
  compareMode,
  fetchActivityDays,
  fetchSendUsage,
  num,
  sendUsageTotal,
  sumSendUsage,
  type ActivityDayRow,
  type SendUsageRow,
} from "@/lib/finance/finance-data.server";
import { getTenantComparisonRow, type TenantComparisonRow } from "@/lib/tenant-comparison.server";
import { brtDayEnd, brtDayStart } from "@/lib/tz";

import type { McpIdentity } from "../access.server";
import type { OpsToolDef } from "./registry.server";
import {
  escopoOps,
  periodoOps,
  porCasa,
  toRange,
  totaisPorMoeda,
  type CasaComErro,
  type PeriodoOps,
  type TotalPorMoeda,
} from "./runner.server";
import { resolverEscopoOps, type CasaOps } from "./scope.server";

// ─── Shared ─────────────────────────────────────────────────────────────────

const round2 = (value: number) => Math.round(value * 100) / 100;
const round1 = (value: number) => Math.round(value * 10) / 10;
const ratio2 = (value: number | null) => (value == null ? null : round2(value));
const pct = (value: number | null) => (value == null ? null : round1(value * 100));

const BASE_STATES = ["ativo", "esfriando", "dormindo", "perdido", "sem_ftd"] as const;
export type BasePorEstado = Record<(typeof BASE_STATES)[number], number>;

/** Day `date` (AAAA-MM-DD) at 00:00 in Brasília. */
const dayStartBrt = (date: string) => new Date(`${date}T00:00:00-03:00`);

type CasaLinha = { id: string; nome: string; moeda: string; grupo: string | null };
const casaLinha = (casa: CasaOps): CasaLinha => ({
  id: casa.id,
  nome: casa.nome,
  moeda: casa.moeda,
  grupo: casa.grupo?.nome ?? null,
});

type PeriodoSaida = { inicio: string; fim: string; preset: PeriodoOps["preset"] };
const periodoSaida = (periodo: PeriodoOps): PeriodoSaida => ({
  inicio: periodo.inicio,
  fim: periodo.fim,
  preset: periodo.preset,
});

const shortMessage = (error: unknown) =>
  (error instanceof Error && error.message ? error.message : "erro desconhecido").slice(0, 200);

// ─── visao_geral ────────────────────────────────────────────────────────────

export const visaoGeralInput = z.object({
  escopo: escopoOps,
  periodo: periodoOps,
  comparar: compareMode
    .optional()
    .describe(
      "Comparação: previous (período anterior; mês contra mês anterior), same_weekday_last_week, last_week, same_period_last_year ou none (padrão).",
    ),
});

/** The house KPIs of a period (money in the house's currency). */
export type KpisCasa = {
  cadastros: number;
  ftds: number;
  depositos: number;
  valor_depositado: number;
  depositantes: number;
  /** null in `anterior`: the RPC does not return the previous withdrawal count. */
  saques: number | null;
  valor_sacado: number;
  ticket_medio: number;
};

export type CrmPeriodo = {
  enviados: number;
  cliques: number;
  conversoes_diretas: number;
  /** In the house's currency. */
  receita_direta: number;
};

export type VisaoGeralCasa = CasaLinha & {
  atual: KpisCasa;
  anterior?: KpisCasa;
  /** Snapshot of now (crm_lifecycle_snapshot), not of the period. */
  base_por_estado: BasePorEstado;
  /** null when the CRM read failed (see `avisos`). */
  crm: CrmPeriodo | null;
  /** Wallet send cost of the period, always BRL. null when the read failed (see `avisos`). */
  custo_envios_brl: number | null;
};

export type VisaoGeralResult = {
  rotulo: string;
  periodo: PeriodoSaida & { comparacao?: { inicio: string; fim: string; modo: string } };
  casas: VisaoGeralCasa[];
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
  avisos?: string[];
};

/** `atual` exactly as the home maps it (mapDashboardRpc), rounded. */
export function kpisAtuais(mapped: ReturnType<typeof mapDashboardRpc>): KpisCasa {
  return {
    cadastros: mapped.newPlayers,
    ftds: mapped.ftd,
    depositos: mapped.depositCount,
    valor_depositado: round2(mapped.depositAmount),
    depositantes: mapped.depositors,
    saques: mapped.withdrawalCount,
    valor_sacado: round2(mapped.withdrawalAmount),
    ticket_medio: round2(mapped.ticket),
  };
}

/** `anterior` from the same payload's previous* fields (same ticket rule as the home). */
export function kpisAnteriores(raw: DashboardRpc): KpisCasa {
  const depositos = num(raw.previousDepositCount);
  const valor = num(raw.previousDepositAmount);
  return {
    cadastros: num(raw.previousNewPlayers),
    ftds: num(raw.previousFtd),
    depositos,
    valor_depositado: round2(valor),
    depositantes: num(raw.previousDepositors),
    saques: null,
    valor_sacado: round2(num(raw.previousWithdrawalAmount)),
    ticket_medio: depositos > 0 ? round2(valor / depositos) : 0,
  };
}

async function baseDaCasa(tenantId: string): Promise<BasePorEstado> {
  const { data, error } = await (supabaseAdmin as unknown as DashboardDb).rpc<
    Array<{ state: string; players: number | string }>
  >("crm_lifecycle_snapshot", { _tenant: tenantId });
  if (error) throw new Error(error.message);
  const byState = new Map((data ?? []).map((row) => [row.state, num(row.players)]));
  return Object.fromEntries(
    BASE_STATES.map((state) => [state, byState.get(state) ?? 0]),
  ) as BasePorEstado;
}

const crmVazio = (): CrmPeriodo => ({
  enviados: 0,
  cliques: 0,
  conversoes_diretas: 0,
  receita_direta: 0,
});

/** CRM of the period per house, from finance_activity_days. */
function crmPorCasa(rows: ActivityDayRow[]): Map<string, CrmPeriodo> {
  const byHouse = new Map<string, CrmPeriodo>();
  for (const row of rows) {
    const crm = byHouse.get(row.tenant_id) ?? crmVazio();
    crm.enviados += num(row.crm_sent);
    crm.cliques += num(row.crm_clicks);
    crm.conversoes_diretas += num(row.crm_direct_conversions);
    crm.receita_direta += num(row.crm_direct_revenue);
    byHouse.set(row.tenant_id, crm);
  }
  for (const crm of byHouse.values()) crm.receita_direta = round2(crm.receita_direta);
  return byHouse;
}

/** Send cost (BRL) of the period per house: sumSendUsage + sendUsageTotal, as the finance panel. */
function custoPorCasa(rows: SendUsageRow[]): Map<string, number> {
  const byHouse = new Map<string, SendUsageRow[]>();
  for (const row of rows) {
    const list = byHouse.get(row.tenant_id) ?? [];
    list.push(row);
    byHouse.set(row.tenant_id, list);
  }
  return new Map(
    Array.from(byHouse, ([tenantId, houseRows]) => [
      tenantId,
      sendUsageTotal(sumSendUsage(houseRows)),
    ]),
  );
}

export async function visaoGeral(
  identity: McpIdentity,
  args: unknown,
  now: Date = new Date(),
): Promise<VisaoGeralResult> {
  const input = visaoGeralInput.parse(args);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, input.escopo);
  const periodo = toRange(input.periodo, now);
  const range = { from: periodo.inicio, to: periodo.fim };
  const modo = input.comparar ?? "none";
  const comparacao = compareRange(range, modo, periodo.preset);

  // Same bounds as the home's getDashboardSummary for this period; with a
  // comparison mode, the RPC's previous window is that mode's window.
  const bounds = dashboardPeriodBounds(
    periodo.fromInstant,
    dayStartBrt(periodo.fim).toISOString(),
    now,
  );
  const prev = comparacao
    ? {
        prevFrom: brtDayStart(dayStartBrt(comparacao.from)).toISOString(),
        prevTo: brtDayEnd(dayStartBrt(comparacao.to)).toISOString(),
      }
    : { prevFrom: bounds.prevFrom, prevTo: bounds.prevTo };

  // CRM and send cost take every house in one call each; a failure there
  // leaves those fields null (with a notice) instead of failing the houses.
  const ids = casas.map((casa) => casa.id);
  const avisos: string[] = [];
  const [porCasaResult, crmRows, usageRows] = await Promise.all([
    porCasa(casas, async (casa) => {
      const [raw, base] = await Promise.all([
        withTimeout(
          fetchDashboardSummaryRpc(supabaseAdmin as unknown as DashboardDb, casa.id, {
            startDate: bounds.startDate,
            endDate: bounds.endDate,
            ...prev,
          }),
          DASHBOARD_REQUEST_TIMEOUT_MS,
          "A casa demorou demais para responder.",
        ),
        baseDaCasa(casa.id),
      ]);
      return { raw, base };
    }),
    fetchActivityDays(ids, range).catch((error: unknown) => {
      avisos.push(`CRM do período indisponível: ${shortMessage(error)}`);
      return null;
    }),
    fetchSendUsage(ids, range).catch((error: unknown) => {
      avisos.push(`Custo de envios indisponível: ${shortMessage(error)}`);
      return null;
    }),
  ]);

  const crm = crmRows ? crmPorCasa(crmRows) : null;
  const custo = usageRows ? custoPorCasa(usageRows) : null;

  const linhas = porCasaResult.ok.map(({ casa, resultado }): VisaoGeralCasa => {
    const mapped = mapDashboardRpc(resultado.raw, bounds.periodDays);
    return {
      ...casaLinha(casa),
      atual: kpisAtuais(mapped),
      ...(comparacao ? { anterior: kpisAnteriores(resultado.raw) } : {}),
      base_por_estado: resultado.base,
      crm: crm ? (crm.get(casa.id) ?? crmVazio()) : null,
      custo_envios_brl: custo ? (custo.get(casa.id) ?? 0) : null,
    };
  });

  const totais = totaisPorMoeda(linhas, (linha) => ({
    moeda: linha.moeda,
    valores: {
      cadastros: linha.atual.cadastros,
      ftds: linha.atual.ftds,
      depositos: linha.atual.depositos,
      valor_depositado: linha.atual.valor_depositado,
      depositantes: linha.atual.depositantes,
      saques: linha.atual.saques,
      valor_sacado: linha.atual.valor_sacado,
      ...linha.base_por_estado,
      crm_enviados: linha.crm?.enviados,
      crm_cliques: linha.crm?.cliques,
      crm_conversoes_diretas: linha.crm?.conversoes_diretas,
      crm_receita_direta: linha.crm?.receita_direta,
      custo_envios_brl: linha.custo_envios_brl,
    },
  }));
  // Ratios come from the summed parts, never summed themselves.
  for (const total of totais) {
    const depositos = total.totais.depositos ?? 0;
    total.totais.ticket_medio =
      depositos > 0 ? round2((total.totais.valor_depositado ?? 0) / depositos) : 0;
  }

  return {
    rotulo,
    periodo: {
      ...periodoSaida(periodo),
      ...(comparacao ? { comparacao: { inicio: comparacao.from, fim: comparacao.to, modo } } : {}),
    },
    casas: linhas,
    totais_por_moeda: totais,
    casas_com_erro: porCasaResult.casas_com_erro,
    ...(avisos.length ? { avisos } : {}),
  };
}

// ─── comparar_casas ─────────────────────────────────────────────────────────

export const compararCasasInput = z.object({
  escopo: escopoOps,
  periodo: periodoOps,
});

export type CompararCasasLinha = CasaLinha & {
  enviados: number;
  /** crm_results_daily cost: always BRL. */
  custo_brl: number;
  cliques: number;
  taxa_clique_pct: number | null;
  conversoes_diretas: number;
  taxa_conversao_pct: number | null;
  custo_por_conversao_brl: number | null;
  /** Direct revenue / cost (x). */
  roi_direto: number | null;
  receita_direta: number;
  jogadores_influenciados: number;
  receita_influenciada: number;
  custo_por_recuperado_brl: number | null;
  /** Influenced revenue / cost (x). */
  roi: number | null;
  custo_em_ativos_pct: number | null;
  /** Snapshot of now, not of the period. */
  base_por_estado: BasePorEstado;
  cadastros: number;
  cadastro_para_ftd_pct: number | null;
  segundo_deposito_7d_pct: number | null;
  /** Week of the latest closed cohort used for segundo_deposito_7d_pct. */
  semana_coorte: string | null;
};

export type CompararCasasResult = {
  rotulo: string;
  periodo: PeriodoSaida;
  casas: CompararCasasLinha[];
  totais_por_moeda: TotalPorMoeda[];
  casas_com_erro: CasaComErro[];
};

/** A panel comparison row in the MCP's pt-BR, rounded shape. */
export function linhaComparacao(casa: CasaOps, row: TenantComparisonRow): CompararCasasLinha {
  return {
    ...casaLinha(casa),
    enviados: row.sent,
    custo_brl: round2(row.cost),
    cliques: row.clicks,
    taxa_clique_pct: pct(row.clickRate),
    conversoes_diretas: row.directPlayers,
    taxa_conversao_pct: pct(row.conversionRate),
    custo_por_conversao_brl: ratio2(row.costPerConversion),
    roi_direto: ratio2(row.clickRoi),
    receita_direta: round2(row.directRevenue),
    jogadores_influenciados: row.influencedPlayers,
    receita_influenciada: round2(row.influencedRevenue),
    custo_por_recuperado_brl: ratio2(row.costPerRecovered),
    roi: ratio2(row.roi),
    custo_em_ativos_pct: pct(row.costOnActiveShare),
    base_por_estado: row.base,
    cadastros: row.signups,
    cadastro_para_ftd_pct: pct(row.signupToFtd),
    segundo_deposito_7d_pct: pct(row.secondDeposit7d),
    semana_coorte: row.cohortWeek,
  };
}

export async function compararCasas(
  identity: McpIdentity,
  args: unknown,
  now: Date = new Date(),
): Promise<CompararCasasResult> {
  const input = compararCasasInput.parse(args);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, input.escopo);
  const periodo = toRange(input.periodo, now);
  const range = { from: periodo.inicio, to: periodo.fim };

  const { ok, casas_com_erro } = await porCasa(casas, (casa) =>
    getTenantComparisonRow({ id: casa.id, nome: casa.nome, moeda: casa.moeda }, range, now),
  );
  const linhas = ok.map(({ casa, resultado }) => linhaComparacao(casa, resultado));

  return {
    rotulo,
    periodo: periodoSaida(periodo),
    casas: linhas,
    totais_por_moeda: totaisPorMoeda(linhas, (linha) => ({
      moeda: linha.moeda,
      valores: {
        enviados: linha.enviados,
        custo_brl: linha.custo_brl,
        cliques: linha.cliques,
        conversoes_diretas: linha.conversoes_diretas,
        receita_direta: linha.receita_direta,
        receita_influenciada: linha.receita_influenciada,
        cadastros: linha.cadastros,
        ...linha.base_por_estado,
      },
    })),
    casas_com_erro,
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const VISAO_TOOLS: OpsToolDef[] = [
  {
    name: "visao_geral",
    title: "Visão geral da operação",
    description:
      "Números da operação por casa no período: cadastros, FTDs, depósitos (quantidade e valor_depositado), depositantes, saques (quantidade e valor_sacado) e ticket médio, em `atual` e, com `comparar`, em `anterior`. Também a base por estado agora (ativo, esfriando, dormindo, perdido, sem_ftd: retrato de hoje, não do período), o CRM do período (enviados, cliques, conversões diretas, receita direta) e o custo de envios em BRL (custo_envios_brl). Dinheiro na moeda de cada casa, exceto custo_envios_brl (sempre BRL); totais_por_moeda traz um total por moeda, nunca soma entre moedas. Casas que falharem vêm em casas_com_erro. Sem GGR nem lucro (use resumo_financeiro).",
    inputSchema: visaoGeralInput,
    run: (identity, args) => visaoGeral(identity, args),
  },
  {
    name: "comparar_casas",
    title: "Comparar casas",
    description:
      "O que a tela Comparar casas mostra, uma linha por casa no período: CRM (enviados, custo_brl, cliques, taxa de clique, conversões diretas, taxa de conversão, custo por conversão, ROI direto, receitas direta e influenciada, custo por recuperado, ROI, % do custo em jogadores já ativos), base por estado agora (ativo, esfriando, dormindo, perdido, sem_ftd), funil cadastro→FTD e 2º depósito em 7 dias da última safra semanal fechada. Taxas em % (campos *_pct), ROI em vezes. Receitas na moeda da casa; custos sempre em BRL (campos *_brl). totais_por_moeda soma por moeda, nunca entre moedas. Casas que falharem vêm em casas_com_erro.",
    inputSchema: compararCasasInput,
    run: (identity, args) => compararCasas(identity, args),
  },
];
