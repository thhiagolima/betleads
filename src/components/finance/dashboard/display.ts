// Pure display rules of the Financeiro painel (presentation only, no math):
// when a variation is worth showing, why a value is missing ("—" plus a
// short reason), labels for the period and the pending banner, and which
// months of the 12-month chart have no data.
import { pctChange, ppChange } from "@/lib/finance/calc";
import type { DateRange, MonthPoint, PeriodSummary } from "@/lib/finance/types";

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-10" → "outubro". */
export function monthName(month: string): string {
  return MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
}

/** True when anything moved in the period (money, players or result). */
export function periodHasData(period: PeriodSummary): boolean {
  return [
    period.depositAmount,
    period.withdrawalAmount,
    period.adSpend,
    period.ggr,
    period.registrations,
    period.ftds,
    period.cashResult,
  ].some((value) => value !== 0);
}

/**
 * The variation to show, or null to show nothing: both values must exist and
 * the compared period must have data.
 */
export function visibleChange(
  current: number | null,
  previous: number | null,
  { hasPrevious, points = false }: { hasPrevious: boolean; points?: boolean },
): number | null {
  if (!hasPrevious || current === null || previous === null) return null;
  return points ? ppChange(current, previous) : pctChange(current, previous);
}

/** Reason the cost per cadastro/FTD has no value. */
export function costPerPlayerReason(period: PeriodSummary): string | null {
  return period.adSpend === 0 ? "sem anúncios" : null;
}

/** GGR is zero while days are still pending: it was not launched yet. */
export function ggrNotLaunched(period: PeriodSummary): boolean {
  return (period.ggr === null || period.ggr === 0) && period.pendingDays > 0;
}

/** A return (revenue ÷ cost) as a multiple: 2.345 → "2,3×". */
export function formatMultiple(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}×`;
}

/** "28 dias de outubro sem anúncios ou GGR lançados." */
export function pendingTitle(dates: string[]): string {
  const months = [...new Set([...dates].sort().map((date) => date.slice(0, 7)))].map(monthName);
  const count = dates.length === 1 ? "1 dia" : `${dates.length} dias`;
  return `${count} de ${months.join(" e ")} sem anúncios ou GGR lançados.`;
}

const ddmm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** "outubro de 2026" for a window from a month's first day; dates otherwise. */
export function periodLabel(range: DateRange): string {
  if (range.from.endsWith("-01") && range.from.slice(0, 7) === range.to.slice(0, 7)) {
    return `${monthName(range.from)} de ${range.from.slice(0, 4)}`;
  }
  if (range.from === range.to) return `${ddmm(range.from)}/${range.from.slice(0, 4)}`;
  return `${ddmm(range.from)} a ${ddmm(range.to)}/${range.to.slice(0, 4)}`;
}

const SHORT_STEP_LABELS: Record<string, string> = {
  "Taxa de movimentação": "Taxa de mov.",
};

/** A waterfall step name short enough for one line under its column. */
export function shortStepLabel(label: string): string {
  return SHORT_STEP_LABELS[label] ?? label;
}

/**
 * A month of the 12-month chart with nothing to show: no result, net or
 * deposits, and either before the scope's data starts or with no ads either.
 */
export function emptyMonth(point: MonthPoint, betleadsSince: string | null): boolean {
  if (point.cashResult !== 0 || point.net !== 0 || point.depositAmount !== 0) return false;
  const beforeData = betleadsSince === null || point.month < betleadsSince.slice(0, 7);
  return beforeData || point.adSpend === 0;
}

/** "Os dados financeiros desta casa começam em …" when fewer than 3 months have data. */
export function trendStartHint(months: MonthPoint[], betleadsSince: string | null): string | null {
  const withData = months.filter((point) => !emptyMonth(point, betleadsSince));
  if (withData.length === 0 || withData.length >= 3) return null;
  const first = withData[0].month;
  return `Os dados financeiros desta casa começam em ${monthName(first)} de ${first.slice(0, 4)}.`;
}
