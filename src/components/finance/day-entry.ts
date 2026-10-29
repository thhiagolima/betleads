// Pure helpers of Lançamentos as a day list with a day modal
// (docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md §3.4): each day's status
// chip, the "Dia anterior"/"Próximo dia" neighbors, the "Usar gasto da Meta
// nos dias vazios" entries and the day's result (sends and other costs of
// that day taken off its cash result, plus the waterfall).
import { presetRange, round2, summarize } from "@/lib/finance/calc";
import { waterfallSteps } from "@/lib/finance/kpis";
import type { FinanceDay, PeriodSummary, SendUsage, WaterfallStep } from "@/lib/finance/types";

export type DayStatus =
  | "completo"
  | "falta anúncios"
  | "falta GGR"
  | "falta anúncios e GGR"
  | "falta GGR do mês"
  | "falta anúncios e GGR do mês"
  | "estimado";

/**
 * Missing inputs win; a GGR allocated from the month's total (ads filled) is
 * "estimado". With a month total (`usingMonthlyGgr`), a day without GGR is
 * one after its "atualizado até": what is missing is the month's GGR, not
 * a daily one.
 */
export function dayStatus(day: FinanceDay, usingMonthlyGgr = false): DayStatus {
  const noAds = day.adSpend === null;
  const noGgr = day.ggr === null;
  const ggrName = usingMonthlyGgr ? "GGR do mês" : "GGR";
  if (noAds && noGgr) return `falta anúncios e ${ggrName}`;
  if (noAds) return "falta anúncios";
  if (noGgr) return `falta ${ggrName}`;
  if (day.ggrEstimated) return "estimado";
  return "completo";
}

/**
 * The closest listed dates before and after `current` (the month's days),
 * never past the month's last listed date nor after `today`.
 */
export function neighborDays(
  dates: string[],
  current: string,
  today: string,
): { prev: string | null; next: string | null } {
  let prev: string | null = null;
  let next: string | null = null;
  for (const date of dates) {
    if (date < current && (prev === null || date > prev)) prev = date;
    if (date > current && date <= today && (next === null || date < next)) next = date;
  }
  return { prev, next };
}

/**
 * Days before `today` with no Anúncios and a Meta suggestion, to fill in one
 * save. Today is left out: its Meta spend is still growing.
 */
export function metaFillEntries(
  days: FinanceDay[],
  today: string,
): { date: string; adSpend: number }[] {
  return days.flatMap((day) =>
    day.date < today && day.adSpend === null && day.adSpendSuggested !== null
      ? [{ date: day.date, adSpend: day.adSpendSuggested }]
      : [],
  );
}

/**
 * What leaving the open day does. Moving to another day saves the typed
 * Anúncios/GGR first (and stays on a save error); closing never saves, so
 * anything typed asks "Descartar alterações?". A cost typed but not added is
 * lost either way, so it always asks.
 */
export function leaveDayPlan(
  kind: "move" | "close",
  state: { dayDirty: boolean; costDirty: boolean },
): { save: boolean; confirm: boolean } {
  if (kind === "move") return { save: state.dayDirty, confirm: state.costDirty };
  return { save: false, confirm: state.dayDirty || state.costDirty };
}

/** Σ amount of a day's sends (R$). */
export function daySendCost(sends: SendUsage[] | undefined): number {
  return round2((sends ?? []).reduce((total, usage) => total + usage.amount, 0));
}

export type DayCost = { valor: number; categoria: string };

/** The day's Lucro líquido and its waterfall: its sends and other costs taken off. */
export function dayResult(
  day: FinanceDay,
  sends: SendUsage[] | undefined,
  costs: DayCost[],
): { summary: PeriodSummary; sendCost: number; steps: WaterfallStep[] } {
  const sendCost = daySendCost(sends);
  const categories: Record<string, number> = {};
  for (const cost of costs) {
    categories[cost.categoria] = round2((categories[cost.categoria] ?? 0) + cost.valor);
  }
  const otherCosts = round2(costs.reduce((total, cost) => total + cost.valor, 0));
  const summary = summarize([day], otherCosts, undefined, { usage: sendCost, fee: null });
  return { summary, sendCost, steps: waterfallSteps(summary, sendCost, categories) };
}

/** "28/10 · ter" */
export function dayLabel(date: string): string {
  const weekday = new Date(`${date}T12:00:00Z`)
    .toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" })
    .replace(".", "");
  return `${date.slice(8, 10)}/${date.slice(5, 7)} · ${weekday}`;
}

/** "YYYY-MM" of the current month in São Paulo, the same day boundary as the server. */
export function currentMonth() {
  return presetRange("today", new Date()).from.slice(0, 7);
}

/** "YYYY-MM-DD" of today in São Paulo, the same day boundary as the server. */
export function todaySaoPaulo() {
  return presetRange("today", new Date()).from;
}
