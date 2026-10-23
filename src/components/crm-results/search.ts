export const PERIODS = [
  { key: "hoje", label: "Hoje", days: 1, endOffset: 0 },
  { key: "ontem", label: "Ontem", days: 1, endOffset: 1 },
  { key: "7", label: "7 dias", days: 7, endOffset: 0 },
  { key: "30", label: "30 dias", days: 30, endOffset: 0 },
  { key: "90", label: "90 dias", days: 90, endOffset: 0 },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export const TABS = [
  { key: "visao", label: "Visão geral" },
  { key: "origens", label: "Origens" },
  { key: "controle", label: "Teste de controle" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];

/**
 * Tabs that left the Central: "base" moved to Aquisição e LTV › Retenção (the
 * route redirects there) and "recomendacoes" lives in the Visão geral.
 */
export const RETIRED_TABS = ["base", "recomendacoes"] as const;
export type RetiredTabKey = (typeof RETIRED_TABS)[number];

export type CentralSearch = {
  periodo?: PeriodKey;
  aba?: TabKey | RetiredTabKey;
  busca?: string;
};

/** Search params of /resultados: period, tab and origin search survive reloads and links (A-05). */
export function validateCentralSearch(search: Record<string, unknown>): CentralSearch {
  const result: CentralSearch = {};
  if (PERIODS.some((period) => period.key === search.periodo))
    result.periodo = search.periodo as PeriodKey;
  if (
    TABS.some((tab) => tab.key === search.aba) ||
    RETIRED_TABS.includes(search.aba as RetiredTabKey)
  )
    result.aba = search.aba as TabKey | RetiredTabKey;
  if (typeof search.busca === "string" && search.busca) result.busca = search.busca.slice(0, 100);
  return result;
}
