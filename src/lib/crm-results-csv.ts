// Central de Resultados F5: CSV export of the period, one line per origin and
// one per journey step, with the same numbers shown on screen.
// Colunas de valor levam a moeda no nome: custo sempre em BRL, receita na moeda
// da casa. Fora de BRL os R$ por R$ 1 em SMS (receita ÷ custo) ficam vazios: sem câmbio.
import type { CrmMetricsWithRatios, CrmResults } from "./crm-results";
import { DEFAULT_CURRENCY, toTenantCurrency, type TenantCurrency } from "./currency";

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const amount = (value: number | null) => (value == null ? "" : value.toFixed(2));

const header = (currency: TenantCurrency) => {
  const house = currency.toLowerCase();
  return [
    "periodo_inicio",
    "periodo_fim",
    "tipo",
    "origem",
    "etapa",
    "sms_enviados",
    "falhas",
    "destinatarios",
    "custo_brl",
    "custo_em_quem_ja_estava_jogando_brl",
    "cliques_no_link",
    "taxa_de_clique",
    "jogadores_que_voltaram_pelo_link",
    "taxa_cliques_que_viraram_deposito",
    `recuperado_pelo_crm_${house}`,
    "custo_por_jogador_que_voltou_brl",
    "reais_por_real_em_sms",
    "reativacoes_apos_sms",
    "depositos_reativacoes",
    `depositado_7d_reativacoes_${house}`,
    "custo_por_reativacao_brl",
    "retorno_reativacoes",
    "depositos_apos_clique",
    "cliques_que_viraram_deposito",
    "jogadores_ja_estavam_jogando_clique",
    `receita_ja_estavam_jogando_clique_${house}`,
  ];
};

const metricCells = (metrics: CrmMetricsWithRatios) => [
  metrics.sent,
  metrics.failed,
  metrics.recipients,
  amount(metrics.cost),
];

const rate = (value: number | null) => (value == null ? "" : value.toFixed(4));

const resultCells = (metrics: CrmMetricsWithRatios, sameCurrency: boolean) => [
  metrics.humanClicks,
  rate(metrics.clickRate),
  metrics.directPlayers,
  rate(metrics.conversionRate),
  amount(metrics.directRevenue),
  amount(metrics.costPerConversion),
  !sameCurrency || metrics.clickRoi == null ? "" : metrics.clickRoi.toFixed(2),
  metrics.influencedPlayers,
  metrics.influencedDeposits,
  amount(metrics.influencedRevenue),
  amount(metrics.costPerRecovered),
  !sameCurrency || metrics.roi == null ? "" : metrics.roi.toFixed(2),
  metrics.directConversions,
  metrics.convertedClicks,
  metrics.directActivePlayers,
  amount(metrics.directActiveRevenue),
];

export function crmResultsCsv(
  results: Pick<CrmResults, "totals" | "sources">,
  period: { from: string; to: string },
  houseCurrency: TenantCurrency | string = DEFAULT_CURRENCY,
): string {
  const currency = toTenantCurrency(houseCurrency);
  const sameCurrency = currency === "BRL";
  const lines: unknown[][] = [header(currency)];
  const prefix = [period.from, period.to];
  lines.push([
    ...prefix,
    "total",
    "Todas as origens",
    "",
    ...metricCells(results.totals),
    amount(results.totals.costOnActive),
    ...resultCells(results.totals, sameCurrency),
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
      ...resultCells(source, sameCurrency),
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
        ...resultCells(step, sameCurrency),
      ]);
    }
  }
  // BOM so Excel opens accents correctly.
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\n");
}
