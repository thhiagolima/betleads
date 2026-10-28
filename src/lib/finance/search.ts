// URL search of the Financeiro pages (/financeiro and /grupo/casa): which tab
// is open and, for "Lançar agora", the month and day the Lançamentos grid
// opens on (spec §4, §5.2).

export const FINANCE_TABS = ["painel", "lancamentos", "outros-custos", "configuracoes"] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number];

export type FinanceSearch = {
  tab?: FinanceTab;
  /** "YYYY-MM" */
  month?: string;
  /** "YYYY-MM-DD" */
  dia?: string;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Keeps only valid values; a missing tab means Painel. */
export function parseFinanceSearch(
  search: Record<string, unknown>,
  allowedTabs: readonly FinanceTab[] = FINANCE_TABS,
): FinanceSearch {
  const out: FinanceSearch = {};
  const { tab, month, dia } = search;
  if (typeof tab === "string" && (allowedTabs as readonly string[]).includes(tab)) {
    out.tab = tab as FinanceTab;
  }
  if (typeof month === "string" && MONTH_RE.test(month)) out.month = month;
  if (typeof dia === "string" && DAY_RE.test(dia)) out.dia = dia;
  return out;
}

/** Where "Lançar agora" goes: Lançamentos, on the date's month, focused on it. */
export function launchPendingSearch(date: string): Required<FinanceSearch> {
  return { tab: "lancamentos", month: date.slice(0, 7), dia: date };
}
