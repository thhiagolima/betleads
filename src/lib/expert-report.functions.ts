// Server functions do relatório de rendimento de uma pessoa e da equipe
// (spec 2026-10-28-relatorio-rendimento-design.md §4, §5, §6, §7): resultado
// do período com a comparação, série diária, top leads, carteira (+ CSV), o
// histórico do lead com a pessoa, e o ranking da equipe para o admin (+ CSV).
//
// Acesso do relatório individual: `resolveReportSubject` — sem `expertId`, o
// próprio usuário (expert ou perfil da equipe); com `expertId`, só o admin
// da casa. A mesma função monta o relatório para a pessoa e para o admin.
// O relatório da equipe (`getTeamReportFor`) é sempre do admin
// (`requireExpertAdminTenant`): não há visão própria dele.
//
// Consomem as funções SQL `expert_report`, `expert_report_daily`,
// `expert_portfolio`, `expert_lead_timeline`, `expert_team_report`,
// `house_deposit_totals` e `expert_last_computed_at` (migrations
// 20261106153000/20261106153100), todas service_role e fora dos tipos
// gerados do Supabase → `(supabaseAdmin as any)`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CONTATO_LABEL, type ContatoResultado } from "@/lib/expert-lead-labels";
import {
  brValor,
  creditsCsvCell,
  formatBrtDateTimeCsv,
  getClickWindowHours,
  slugify,
} from "@/lib/expert-metrics.functions";
import {
  comparisonRange,
  EXPERT_PERIOD_KEYS,
  periodRange,
  variationPct,
} from "@/lib/expert-period";
import {
  resolveReportSubject,
  tipoLabelOf,
  type ReportSubject,
  type ServerContext,
} from "@/lib/expert-report-subject.server";
import { listExpertsFor, requireExpertAdminTenant } from "@/lib/experts-admin.functions";
import { brtDayKey } from "@/lib/tz";
import { dbUuid } from "@/lib/zod-helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

const periodKeySchema = z.enum(EXPERT_PERIOD_KEYS);

const TOP_LEADS = 10;
const PORTFOLIO_PAGE_SIZE = 50;
const PORTFOLIO_CSV_CHUNK = 1000;
const TIMELINE_LIMIT = 100;
const CREDITS_CHUNK = 1000;

// ---------------------------------------------------------- report

export type ReportBlock = {
  depositado: number;
  depositadoClique: number;
  depositadoAfiliado: number;
  ftds: number;
  valorFtd: number;
  redepositos: number;
  valorRedeposito: number;
  ticketRedeposito: number | null;
  reativados: number;
  depositantes: number;
  links: number;
  leadsComLink: number;
  leadsClicaram: number;
  leadsDepositaramClique: number;
  contatos: number;
};

type ReportDbRow = {
  depositado: number | string;
  depositado_clique: number | string;
  depositado_afiliado: number | string;
  ftds: number;
  valor_ftd: number | string;
  redepositos: number;
  valor_redeposito: number | string;
  reativados: number;
  depositantes: number;
  links: number;
  leads_com_link: number;
  leads_clicaram: number;
  leads_depositaram_clique: number;
  contatos: number;
};

type DailyDbRow = {
  dia: string;
  valor_ftd: number | string;
  valor_redeposito: number | string;
  depositantes: number;
};

function mapReportBlock(row: ReportDbRow | undefined): ReportBlock {
  const n = (v: number | string | undefined) => Number(v ?? 0);
  const redepositos = n(row?.redepositos);
  const valorRedeposito = n(row?.valor_redeposito);
  return {
    depositado: n(row?.depositado),
    depositadoClique: n(row?.depositado_clique),
    depositadoAfiliado: n(row?.depositado_afiliado),
    ftds: n(row?.ftds),
    valorFtd: n(row?.valor_ftd),
    redepositos,
    valorRedeposito,
    ticketRedeposito: redepositos > 0 ? valorRedeposito / redepositos : null,
    reativados: n(row?.reativados),
    depositantes: n(row?.depositantes),
    links: n(row?.links),
    leadsComLink: n(row?.leads_com_link),
    leadsClicaram: n(row?.leads_clicaram),
    leadsDepositaramClique: n(row?.leads_depositaram_clique),
    contatos: n(row?.contatos),
  };
}

async function fetchReportBlock(
  tenantId: string,
  expertId: string,
  range: { from: string; to: string },
): Promise<ReportBlock> {
  const { data, error } = await db().rpc("expert_report", {
    _tenant: tenantId,
    _expert: expertId,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  return mapReportBlock(((data ?? []) as ReportDbRow[])[0]);
}

async function fetchReportDaily(
  tenantId: string,
  expertId: string,
  range: { from: string; to: string },
) {
  const { data, error } = await db().rpc("expert_report_daily", {
    _tenant: tenantId,
    _expert: expertId,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as DailyDbRow[]).map((r) => ({
    dia: r.dia,
    valorFtd: Number(r.valor_ftd),
    valorRedeposito: Number(r.valor_redeposito),
    depositantes: Number(r.depositantes),
  }));
}

async function fetchLastComputedAt(tenantId: string): Promise<string | null> {
  const { data, error } = await db().rpc("expert_last_computed_at", { _tenant: tenantId });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

const reportInput = z.object({ period: periodKeySchema, expertId: dbUuid().optional() });

export const getExpertReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => reportInput.parse(data))
  .handler(async ({ data, context }) =>
    getExpertReportFor(context as unknown as ServerContext, data),
  );

export async function getExpertReportFor(
  ctx: ServerContext,
  data: z.input<typeof reportInput>,
): Promise<{
  subject: ReportSubject;
  current: ReportBlock;
  previous: ReportBlock;
  variacao: {
    depositado: number | null;
    ftds: number | null;
    redepositos: number | null;
    reativados: number | null;
  };
  serie: { dia: string; valorFtd: number; valorRedeposito: number; depositantes: number }[];
  topLeads: PortfolioRow[];
  janelaHoras: number;
  atualizadoEm: string | null;
}> {
  const input = reportInput.parse(data);
  const subject = await resolveReportSubject(ctx, input.expertId);
  const { tenantId, expertId } = subject;
  const ranges = comparisonRange(input.period, new Date());

  const [current, previous, serie, top, janelaHoras, atualizadoEm] = await Promise.all([
    fetchReportBlock(tenantId, expertId, ranges.current),
    fetchReportBlock(tenantId, expertId, ranges.previous),
    fetchReportDaily(tenantId, expertId, ranges.current),
    fetchPortfolio(tenantId, expertId, ranges.current, {}, TOP_LEADS, 0),
    getClickWindowHours(tenantId),
    fetchLastComputedAt(tenantId),
  ]);

  return {
    subject,
    current,
    previous,
    variacao: {
      depositado: variationPct(current.depositado, previous.depositado),
      ftds: variationPct(current.ftds, previous.ftds),
      redepositos: variationPct(current.redepositos, previous.redepositos),
      reativados: variationPct(current.reativados, previous.reativados),
    },
    serie,
    topLeads: top.rows,
    janelaHoras,
    atualizadoEm,
  };
}

// ---------------------------------------------------------- portfolio

export type PortfolioRow = {
  playerId: string;
  nome: string;
  telefone: string | null;
  creditado: number;
  depositos: number;
  origem: "clique" | "afiliado" | "ambos";
  primeiroCredito: string;
  ultimoDeposito: string | null;
  ultimoContato: { resultado: string; em: string } | null;
  temFtd: boolean;
  reativado: boolean;
};

type PortfolioDbRow = {
  player_id: string;
  nome: string;
  telefone: string | null;
  creditado: number | string;
  depositos: number;
  origem: "clique" | "afiliado" | "ambos";
  primeiro_credito: string;
  ultimo_deposito: string | null;
  ultimo_contato_resultado: string | null;
  ultimo_contato_em: string | null;
  tem_ftd: boolean;
  reativado: boolean;
  total_count: number | string;
};

type PortfolioFilters = { search?: string; onlyFtd?: boolean; onlyReativados?: boolean };

function mapPortfolioRow(r: PortfolioDbRow): PortfolioRow {
  return {
    playerId: r.player_id,
    nome: r.nome,
    telefone: r.telefone,
    creditado: Number(r.creditado),
    depositos: Number(r.depositos),
    origem: r.origem,
    primeiroCredito: r.primeiro_credito,
    ultimoDeposito: r.ultimo_deposito,
    ultimoContato:
      r.ultimo_contato_resultado && r.ultimo_contato_em
        ? { resultado: r.ultimo_contato_resultado, em: r.ultimo_contato_em }
        : null,
    temFtd: r.tem_ftd,
    reativado: r.reativado,
  };
}

async function fetchPortfolio(
  tenantId: string,
  expertId: string,
  range: { from: string; to: string },
  filters: PortfolioFilters,
  limit: number,
  offset: number,
): Promise<{ rows: PortfolioRow[]; total: number }> {
  const { data, error } = await db().rpc("expert_portfolio", {
    _tenant: tenantId,
    _expert: expertId,
    _from: range.from,
    _to: range.to,
    _search: filters.search?.trim() || null,
    _only_ftd: filters.onlyFtd ?? false,
    _only_reativados: filters.onlyReativados ?? false,
    _limit: limit,
    _offset: offset,
  });
  if (error) throw new Error(error.message);
  const dbRows = (data ?? []) as PortfolioDbRow[];
  return {
    rows: dbRows.map(mapPortfolioRow),
    total: dbRows.length > 0 ? Number(dbRows[0].total_count) : 0,
  };
}

const portfolioFiltersSchema = {
  period: periodKeySchema,
  expertId: dbUuid().optional(),
  search: z.string().max(80).optional(),
  onlyFtd: z.boolean().optional(),
  onlyReativados: z.boolean().optional(),
};

const portfolioInput = z.object({
  ...portfolioFiltersSchema,
  page: z.number().int().min(0),
});

export const listExpertPortfolio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => portfolioInput.parse(data))
  .handler(async ({ data, context }) =>
    listExpertPortfolioFor(context as unknown as ServerContext, data),
  );

export async function listExpertPortfolioFor(
  ctx: ServerContext,
  data: z.input<typeof portfolioInput>,
): Promise<{ rows: PortfolioRow[]; total: number }> {
  const input = portfolioInput.parse(data);
  const { tenantId, expertId } = await resolveReportSubject(ctx, input.expertId);
  const range = periodRange(input.period, new Date());
  return fetchPortfolio(
    tenantId,
    expertId,
    range,
    input,
    PORTFOLIO_PAGE_SIZE,
    input.page * PORTFOLIO_PAGE_SIZE,
  );
}

const PORTFOLIO_CSV_HEADER = [
  "Lead",
  "Telefone",
  "Creditado",
  "Depósitos",
  "Origem",
  "1º crédito",
  "Último depósito",
  "Último contato",
  "FTD",
  "Reativado",
];

const ORIGEM_CSV: Record<PortfolioRow["origem"], string> = {
  clique: "Clique",
  afiliado: "Afiliado",
  ambos: "Ambos",
};

function contatoCsv(contato: PortfolioRow["ultimoContato"]): string {
  if (!contato) return "";
  const label = CONTATO_LABEL[contato.resultado as ContatoResultado] ?? contato.resultado;
  return `${label} em ${formatBrtDateTimeCsv(contato.em)}`;
}

const exportPortfolioInput = z.object(portfolioFiltersSchema);

export const exportExpertPortfolioCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => exportPortfolioInput.parse(data))
  .handler(async ({ data, context }) =>
    exportExpertPortfolioCsvFor(context as unknown as ServerContext, data),
  );

export async function exportExpertPortfolioCsvFor(
  ctx: ServerContext,
  data: z.input<typeof exportPortfolioInput>,
): Promise<{ filename: string; csv: string }> {
  const input = exportPortfolioInput.parse(data);
  const subject = await resolveReportSubject(ctx, input.expertId);
  const range = periodRange(input.period, new Date());

  const rows: PortfolioRow[] = [];
  for (let offset = 0; ; offset += PORTFOLIO_CSV_CHUNK) {
    const chunk = await fetchPortfolio(
      subject.tenantId,
      subject.expertId,
      range,
      input,
      PORTFOLIO_CSV_CHUNK,
      offset,
    );
    rows.push(...chunk.rows);
    if (chunk.rows.length < PORTFOLIO_CSV_CHUNK) break;
  }

  const lines = [PORTFOLIO_CSV_HEADER.join(";")];
  let soma = 0;
  let depositos = 0;
  for (const row of rows) {
    soma += row.creditado;
    depositos += row.depositos;
    lines.push(
      [
        row.nome,
        row.telefone ?? "",
        brValor(row.creditado),
        String(row.depositos),
        ORIGEM_CSV[row.origem],
        formatBrtDateTimeCsv(row.primeiroCredito),
        row.ultimoDeposito ? formatBrtDateTimeCsv(row.ultimoDeposito) : "",
        contatoCsv(row.ultimoContato),
        row.temFtd ? "Sim" : "Não",
        row.reativado ? "Sim" : "Não",
      ]
        .map(creditsCsvCell)
        .join(";"),
    );
  }
  lines.push(["Total", "", brValor(soma), String(depositos), "", "", "", "", "", ""].join(";"));

  const fromDay = brtDayKey(new Date(range.from));
  // `to` é exclusivo e pode ser "agora": o dia do último instante incluído
  // é 1ms antes (mesma regra do extrato).
  const toDay = brtDayKey(new Date(new Date(range.to).getTime() - 1));
  const filename = `carteira-${slugify(subject.nome)}-${fromDay}-a-${toDay}.csv`;

  // BOM UTF-8 para o Excel (pt-BR) abrir os acentos corretamente.
  return { filename, csv: "﻿" + lines.join("\n") };
}

// ---------------------------------------------------------- lead timeline

export type TimelineItem = {
  at: string;
  kind: "link" | "clique" | "contato" | "deposito";
  titulo: string;
  detalhe: string | null;
  valor: number | null;
  status: "creditado" | "outra_pessoa" | "nao_creditado" | "pendente" | null;
};

type TimelineDbRow = {
  at: string;
  kind: TimelineItem["kind"];
  titulo: string;
  detalhe: string | null;
  valor: number | string | null;
  status: TimelineItem["status"];
};

/** Créditos da pessoa para o lead em todo o histórico (cabeçalho do painel). */
async function fetchLeadSummary(
  tenantId: string,
  expertId: string,
  playerId: string,
): Promise<{ creditado: number; depositos: number; desde: string | null }> {
  let creditado = 0;
  let depositos = 0;
  let desde: string | null = null;
  for (let offset = 0; ; offset += CREDITS_CHUNK) {
    const { data, error } = await db()
      .from("expert_deposit_credits")
      .select("deposit_id,deposit_at,valor")
      .eq("tenant_id", tenantId)
      .eq("expert_id", expertId)
      .eq("player_id", playerId)
      .order("deposit_at", { ascending: true })
      .order("deposit_id", { ascending: true })
      .range(offset, offset + CREDITS_CHUNK - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ deposit_at: string; valor: number | string }>;
    if (offset === 0 && rows.length > 0) desde = rows[0].deposit_at;
    for (const r of rows) creditado += Number(r.valor);
    depositos += rows.length;
    if (rows.length < CREDITS_CHUNK) break;
  }
  return { creditado, depositos, desde };
}

const timelineInput = z.object({
  playerId: dbUuid(),
  expertId: dbUuid().optional(),
  before: z
    .string()
    .max(64)
    .refine((v) => !Number.isNaN(Date.parse(v)), "Data inválida")
    .optional(),
});

export const getExpertLeadTimeline = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => timelineInput.parse(data))
  .handler(async ({ data, context }) =>
    getExpertLeadTimelineFor(context as unknown as ServerContext, data),
  );

export async function getExpertLeadTimelineFor(
  ctx: ServerContext,
  data: z.input<typeof timelineInput>,
): Promise<{
  resumo: { creditado: number; depositos: number; desde: string | null };
  items: TimelineItem[];
  nextBefore: string | null;
}> {
  const input = timelineInput.parse(data);
  const { tenantId, expertId } = await resolveReportSubject(ctx, input.expertId);

  const [resumo, { data: rows, error }] = await Promise.all([
    fetchLeadSummary(tenantId, expertId, input.playerId),
    db().rpc("expert_lead_timeline", {
      _tenant: tenantId,
      _expert: expertId,
      _player: input.playerId,
      _before: input.before ?? null,
      _limit: TIMELINE_LIMIT,
    }),
  ]);
  if (error) throw new Error(error.message);

  const items = ((rows ?? []) as TimelineDbRow[]).map((r) => ({
    at: r.at,
    kind: r.kind,
    titulo: r.titulo,
    detalhe: r.detalhe,
    valor: r.valor === null ? null : Number(r.valor),
    status: r.status,
  }));
  // O SQL usa WITH TIES: uma página pode passar do limite, mas nunca corta
  // um instante ao meio, então o cursor é o `at` do último item.
  const nextBefore = items.length >= TIMELINE_LIMIT ? items[items.length - 1].at : null;

  return { resumo, items, nextBefore };
}

// ---------------------------------------------------------- team report (spec §5)

export type TeamReportRow = {
  expertId: string;
  nome: string;
  tipoLabel: string;
  ativo: boolean;
  creditado: number;
  variacao: number | null;
  ftds: number;
  redepositos: number;
  reativados: number;
  /** Fração 0–1 (leads_depositaram_clique / leads_clicaram), null sem cliques. */
  cliqueDeposito: number | null;
  /** depositado / depositos (todos os depósitos creditados, não só redepósito). Null sem depósito. */
  ticket: number | null;
};

export type TeamReportResult = {
  totais: {
    creditado: number;
    pctCasaDepositado: number | null;
    ftds: number;
    pctCasaFtds: number | null;
    redepositos: number;
    reativados: number;
  };
  rows: TeamReportRow[];
  janelaHoras: number;
  atualizadoEm: string | null;
};

type TeamReportDbRow = {
  expert_id: string;
  depositado: number | string;
  ftds: number;
  redepositos: number;
  reativados: number;
  leads_clicaram: number;
  leads_depositaram_clique: number;
  depositos: number;
};

type HouseTotalsDbRow = { depositado: number | string; ftds: number };

async function fetchTeamReport(
  tenantId: string,
  range: { from: string; to: string },
): Promise<TeamReportDbRow[]> {
  const { data, error } = await db().rpc("expert_team_report", {
    _tenant: tenantId,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamReportDbRow[];
}

async function fetchHouseDepositTotals(
  tenantId: string,
  range: { from: string; to: string },
): Promise<{ depositado: number; ftds: number }> {
  const { data, error } = await db().rpc("house_deposit_totals", {
    _tenant: tenantId,
    _from: range.from,
    _to: range.to,
  });
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as HouseTotalsDbRow[])[0];
  return { depositado: Number(row?.depositado ?? 0), ftds: Number(row?.ftds ?? 0) };
}

const teamReportInput = z.object({ period: periodKeySchema });

export const getTeamReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => teamReportInput.parse(data))
  .handler(async ({ data, context }) =>
    getTeamReportFor(context as unknown as ServerContext, data),
  );

/** Rendimento da equipe (admin), spec §5: topo com fatia da casa + ranking. */
export async function getTeamReportFor(
  ctx: ServerContext,
  data: z.input<typeof teamReportInput>,
): Promise<TeamReportResult> {
  const input = teamReportInput.parse(data);
  const tenantId = await requireExpertAdminTenant(ctx);
  const ranges = comparisonRange(input.period, new Date());

  const [experts, currentRows, previousRows, houseTotals, janelaHoras, atualizadoEm] =
    await Promise.all([
      listExpertsFor(ctx),
      fetchTeamReport(tenantId, ranges.current),
      fetchTeamReport(tenantId, ranges.previous),
      fetchHouseDepositTotals(tenantId, ranges.current),
      getClickWindowHours(tenantId),
      fetchLastComputedAt(tenantId),
    ]);

  const currentByExpert = new Map(currentRows.map((r) => [r.expert_id, r]));
  const previousByExpert = new Map(previousRows.map((r) => [r.expert_id, r]));

  const rows: TeamReportRow[] = experts
    .map((expert): TeamReportRow => {
      const current = currentByExpert.get(expert.id);
      const previous = previousByExpert.get(expert.id);
      const creditado = Number(current?.depositado ?? 0);
      const previousCreditado = Number(previous?.depositado ?? 0);
      const leadsClicaram = Number(current?.leads_clicaram ?? 0);
      const leadsDepositaramClique = Number(current?.leads_depositaram_clique ?? 0);
      const depositos = Number(current?.depositos ?? 0);
      return {
        expertId: expert.id,
        nome: expert.nome,
        tipoLabel: tipoLabelOf(expert.tipo, expert.papelEquipe),
        ativo: expert.ativo,
        creditado,
        variacao: variationPct(creditado, previousCreditado),
        ftds: Number(current?.ftds ?? 0),
        redepositos: Number(current?.redepositos ?? 0),
        reativados: Number(current?.reativados ?? 0),
        cliqueDeposito: leadsClicaram > 0 ? leadsDepositaramClique / leadsClicaram : null,
        ticket: depositos > 0 ? creditado / depositos : null,
      };
    })
    .sort((a, b) => b.creditado - a.creditado);

  const totaisCreditado = rows.reduce((sum, row) => sum + row.creditado, 0);
  const totaisFtds = rows.reduce((sum, row) => sum + row.ftds, 0);
  const totaisRedepositos = rows.reduce((sum, row) => sum + row.redepositos, 0);
  const totaisReativados = rows.reduce((sum, row) => sum + row.reativados, 0);

  return {
    totais: {
      creditado: totaisCreditado,
      pctCasaDepositado:
        houseTotals.depositado > 0 ? totaisCreditado / houseTotals.depositado : null,
      ftds: totaisFtds,
      pctCasaFtds: houseTotals.ftds > 0 ? totaisFtds / houseTotals.ftds : null,
      redepositos: totaisRedepositos,
      reativados: totaisReativados,
    },
    rows,
    janelaHoras,
    atualizadoEm,
  };
}

const TEAM_REPORT_CSV_HEADER = [
  "Pessoa",
  "Tipo",
  "Creditado",
  "Variação",
  "FTD",
  "Redepósitos",
  "Reativados",
  "Clique→depósito",
  "Ticket médio",
];

/** Percentual pt-BR de 1 casa decimal com "%", "" quando null. `pct` já em percentual (não fração). */
function teamReportCsvPct(pct: number | null): string {
  return pct === null ? "" : `${pct.toFixed(1).replace(".", ",")}%`;
}

/** Como `teamReportCsvPct`, mas recebe uma fração 0–1 (ex.: `cliqueDeposito`). */
function teamReportCsvFraction(fraction: number | null): string {
  return fraction === null ? "" : teamReportCsvPct(Math.round(fraction * 1000) / 10);
}

export const exportTeamReportCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => teamReportInput.parse(data))
  .handler(async ({ data, context }) =>
    exportTeamReportCsvFor(context as unknown as ServerContext, data),
  );

export async function exportTeamReportCsvFor(
  ctx: ServerContext,
  data: z.input<typeof teamReportInput>,
): Promise<{ filename: string; csv: string }> {
  const input = teamReportInput.parse(data);
  const report = await getTeamReportFor(ctx, input);
  const range = periodRange(input.period, new Date());

  const lines = [TEAM_REPORT_CSV_HEADER.join(";")];
  for (const row of report.rows) {
    lines.push(
      [
        row.nome,
        row.tipoLabel,
        brValor(row.creditado),
        teamReportCsvPct(row.variacao),
        String(row.ftds),
        String(row.redepositos),
        String(row.reativados),
        teamReportCsvFraction(row.cliqueDeposito),
        row.ticket === null ? "" : brValor(row.ticket),
      ]
        .map(creditsCsvCell)
        .join(";"),
    );
  }

  const fromDay = brtDayKey(new Date(range.from));
  // `to` é exclusivo e pode ser "agora": o dia do último instante incluído
  // é 1ms antes (mesma regra do extrato e da carteira).
  const toDay = brtDayKey(new Date(new Date(range.to).getTime() - 1));
  const filename = `equipe-${fromDay}-a-${toDay}.csv`;

  // BOM UTF-8 para o Excel (pt-BR) abrir os acentos corretamente.
  return { filename, csv: "﻿" + lines.join("\n") };
}
