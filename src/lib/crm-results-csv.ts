// Central de Resultados F5: CSV export of the period, one line per origin and
// one per journey step, with the same numbers shown on screen.
import type { CrmMetricsWithRatios, CrmResults } from "./crm-results";

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const amount = (value: number | null) => (value == null ? "" : value.toFixed(2));

const HEADER = [
  "periodo_inicio",
  "periodo_fim",
  "tipo",
  "origem",
  "etapa",
  "enviados",
  "falhas",
  "destinatarios",
  "custo",
  "custo_em_ativos",
  "recuperados",
  "depositos_influenciados",
  "receita_influenciada",
  "custo_por_recuperado",
  "retorno",
  "cliques_humanos",
  "conversoes_diretas",
  "receita_direta",
];

const metricCells = (metrics: CrmMetricsWithRatios) => [
  metrics.sent,
  metrics.failed,
  metrics.recipients,
  amount(metrics.cost),
];

const resultCells = (metrics: CrmMetricsWithRatios) => [
  metrics.influencedPlayers,
  metrics.influencedDeposits,
  amount(metrics.influencedRevenue),
  amount(metrics.costPerRecovered),
  metrics.roi == null ? "" : metrics.roi.toFixed(2),
  metrics.humanClicks,
  metrics.directConversions,
  amount(metrics.directRevenue),
];

export function crmResultsCsv(
  results: Pick<CrmResults, "totals" | "sources">,
  period: { from: string; to: string },
): string {
  const lines: unknown[][] = [HEADER];
  const prefix = [period.from, period.to];
  lines.push([
    ...prefix,
    "total",
    "Todas as origens",
    "",
    ...metricCells(results.totals),
    amount(results.totals.costOnActive),
    ...resultCells(results.totals),
  ]);
  for (const source of results.sources) {
    const type = source.type === "journey" ? "jornada" : "campanha";
    lines.push([
      ...prefix,
      type,
      source.name,
      "",
      ...metricCells(source),
      amount(source.costOnActive),
      ...resultCells(source),
    ]);
    for (const step of source.steps) {
      if (step.position < 0) continue;
      lines.push([
        ...prefix,
        type,
        source.name,
        step.position + 1,
        ...metricCells(step),
        "",
        ...resultCells(step),
      ]);
    }
  }
  // BOM so Excel opens accents correctly.
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\n");
}
