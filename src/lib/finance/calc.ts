import type {
  BetleadsCost,
  CompareMode,
  CostLine,
  DateRange,
  FinanceDay,
  FinanceDayInput,
  GoalDay,
  GoalDirection,
  GoalEvaluation,
  GoalMetric,
  GoalStatus,
  PeriodPreset,
  PeriodSummary,
} from "./types";

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

/** Arredonda para 2 casas decimais, meio para longe do zero (como o Excel). */
export function round2(x: number): number {
  const scaled = x * 100;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
  return rounded / 100;
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return round2(items.reduce((total, item) => total + pick(item), 0));
}

export function computeDay(d: FinanceDayInput): FinanceDay {
  const pending = d.adSpend === null || d.ggr === null;

  let net: number | null = null;
  let ggrFee: number | null = null;
  let movementFee: number | null = null;
  let cashResult: number | null = null;
  let roi: number | null = null;

  if (!pending) {
    const adSpend = d.adSpend as number;
    const ggr = d.ggr as number;
    const netValue = round2(d.depositAmount - d.withdrawalAmount);
    const ggrFeeValue = round2(ggr * (d.ggrFeePct / 100));
    const movementFeeValue =
      round2(d.depositAmount * (d.movementFeePct / 100)) +
      round2(d.withdrawalAmount * (d.movementFeePct / 100)) +
      round2(netValue * (d.movementFeePct / 100));
    const cashResultValue = round2(netValue - ggrFeeValue - movementFeeValue - adSpend);

    net = netValue;
    ggrFee = ggrFeeValue;
    movementFee = movementFeeValue;
    cashResult = cashResultValue;
    roi = adSpend === 0 ? null : cashResultValue / adSpend;
  }

  const costPerRegistration =
    d.adSpend === null || d.registrations === 0 ? null : d.adSpend / d.registrations;
  const costPerFtd = d.adSpend === null || d.ftds === 0 ? null : d.adSpend / d.ftds;

  return {
    ...d,
    pending,
    net,
    ggrFee,
    movementFee,
    cashResult,
    roi,
    costPerRegistration,
    costPerFtd,
  };
}

/**
 * Period totals. `today` ("YYYY-MM-DD", São Paulo) is passed explicitly so
 * this stays pure: today is expected to be incomplete, so a pending today is
 * not counted in `pendingDays` (it only sets `pendingToday`). Money results
 * (Net, Resultado) still sum only complete days. `pendingDays` counts
 * distinct dates, so a summary over several houses never counts a day twice.
 */
export function summarize(
  days: FinanceDay[],
  otherCosts: number | null,
  today?: string,
  betleads?: BetleadsCost,
): PeriodSummary {
  const completeDays = days.filter((d) => !d.pending);
  const pendingDates = new Set(days.filter((d) => d.pending).map((d) => d.date));
  const pendingToday = today !== undefined && pendingDates.has(today);
  if (today !== undefined) pendingDates.delete(today);

  const registrations = sumBy(days, (d) => d.registrations);
  const ftds = sumBy(days, (d) => d.ftds);
  const ftdDepositAmount = sumBy(days, (d) => d.ftdDepositAmount);
  const depositAmount = sumBy(days, (d) => d.depositAmount);
  const withdrawalAmount = sumBy(days, (d) => d.withdrawalAmount);
  const adSpend = sumBy(days, (d) => d.adSpend ?? 0);

  const ggr = sumBy(completeDays, (d) => d.ggr ?? 0);
  const net = sumBy(completeDays, (d) => d.net ?? 0);
  const ggrFee = sumBy(completeDays, (d) => d.ggrFee ?? 0);
  const movementFee = sumBy(completeDays, (d) => d.movementFee ?? 0);
  const completeAdSpend = sumBy(completeDays, (d) => d.adSpend ?? 0);
  const rawCashResult = sumBy(completeDays, (d) => d.cashResult ?? 0);

  const betleadsUsage = betleads?.usage ?? 0;
  const betleadsFee = betleads?.fee ?? null;
  const cashResult = round2(rawCashResult - (otherCosts ?? 0) - betleadsUsage - (betleadsFee ?? 0));
  const roi = completeAdSpend === 0 ? null : cashResult / completeAdSpend;
  const costPerRegistration = registrations === 0 ? null : adSpend / registrations;
  const costPerFtd = ftds === 0 ? null : adSpend / ftds;
  const avgDailyCashResult = completeDays.length === 0 ? null : cashResult / completeDays.length;

  return {
    days: days.length,
    pendingDays: pendingDates.size,
    pendingToday,
    registrations,
    ftds,
    ftdDepositAmount,
    depositAmount,
    withdrawalAmount,
    adSpend,
    ggr,
    net,
    ggrFee,
    movementFee,
    otherCosts,
    cashResult,
    roi,
    costPerRegistration,
    costPerFtd,
    avgDailyCashResult,
    betleadsUsage,
    betleadsFee,
  };
}

/** A percent without trailing zeros, pt-BR style: 16 -> "16%", 2.7 -> "2,7%". */
function formatPctNoTrailingZeros(pct: number): string {
  return `${pct.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

/**
 * Cost breakdown shown next to the period summary: the computed lines
 * (Anúncios, Taxa de GGR, Taxa de movimentação, Betleads) plus one line per
 * manually entered cost category. Only Betleads is `auto` (the "automático"
 * tag): Anúncios is typed in and the fees follow it. Sorted by amount descending; a line with
 * amount 0 and no previous amount (0 or null) is dropped as noise.
 */
export function costBreakdown(
  current: PeriodSummary,
  previous: PeriodSummary | null,
  categories: Record<string, number>,
  previousCategories: Record<string, number> | null,
  ggrFeePct: number | null,
): CostLine[] {
  const ggrLabel =
    ggrFeePct === null ? "Taxa de GGR" : `Taxa de GGR (${formatPctNoTrailingZeros(ggrFeePct)})`;

  const lines: CostLine[] = [
    {
      key: "ad_spend",
      label: "Anúncios",
      amount: current.adSpend,
      previous: previous?.adSpend ?? null,
      auto: false,
    },
    {
      key: "ggr_fee",
      label: ggrLabel,
      amount: current.ggrFee,
      previous: previous?.ggrFee ?? null,
      auto: false,
    },
    {
      key: "movement_fee",
      label: "Taxa de movimentação",
      amount: current.movementFee,
      previous: previous?.movementFee ?? null,
      auto: false,
    },
    {
      key: "betleads",
      label: "Betleads",
      amount: round2(current.betleadsUsage + (current.betleadsFee ?? 0)),
      previous: previous ? round2(previous.betleadsUsage + (previous.betleadsFee ?? 0)) : null,
      auto: true,
    },
  ];

  for (const [name, amount] of Object.entries(categories)) {
    lines.push({
      key: `category:${name}`,
      label: name,
      amount,
      previous: previousCategories?.[name] ?? null,
      auto: false,
    });
  }

  return lines
    .filter((line) => !(line.amount === 0 && (line.previous === null || line.previous === 0)))
    .sort((a, b) => b.amount - a.amount);
}

/** Daily average of Anúncios over the days that have it filled (spec §5); null when none. */
export function averageFilledAdSpend(days: FinanceDay[]): number | null {
  const filled = days.filter((d) => d.adSpend !== null);
  if (filled.length === 0) return null;
  return round2(filled.reduce((total, d) => total + (d.adSpend as number), 0) / filled.length);
}

export function metricValue(s: PeriodSummary, m: GoalMetric): number | null {
  switch (m) {
    case "registrations":
      return s.registrations;
    case "ftds":
      return s.ftds;
    case "deposits":
      return s.depositAmount;
    case "net":
      return s.net;
    case "cash_result":
      return s.cashResult;
    case "cost_per_registration":
      return s.costPerRegistration;
    case "cost_per_ftd":
      return s.costPerFtd;
    case "roi":
      return s.roi;
  }
}

export function isSumMetric(m: GoalMetric): boolean {
  return (
    m === "registrations" || m === "ftds" || m === "deposits" || m === "net" || m === "cash_result"
  );
}

export function dependsOnManual(m: GoalMetric): boolean {
  return !(m === "registrations" || m === "ftds" || m === "deposits");
}

function goalStatusForBand(direction: GoalDirection, target: number, value: number): GoalStatus {
  if (target <= 0) {
    if (direction === "gte") return value >= target ? "green" : "red";
    return value <= target ? "green" : "red";
  }

  if (direction === "gte") {
    if (value >= target) return "green";
    if (value >= target * 0.8) return "yellow";
    return "red";
  }

  if (value <= target) return "green";
  if (value <= target * 1.2) return "yellow";
  return "red";
}

function lastGoalDayUpTo(goalDays: GoalDay[], upTo: string): GoalDay {
  const eligible = goalDays.filter((d) => d.date <= upTo);
  const pool = eligible.length > 0 ? eligible : goalDays;
  return pool.reduce((latest, current) => (current.date > latest.date ? current : latest));
}

export function evaluateGoal(
  goalDays: GoalDay[],
  summary: PeriodSummary,
  range: DateRange,
  today?: string,
): GoalEvaluation | null {
  if (goalDays.length === 0) return null;

  const metric = goalDays[0].metric;
  const lastDay = lastGoalDayUpTo(goalDays, range.to);
  const direction = lastDay.direction;
  // A pending today is left out of a manual metric's value (only complete
  // days are summed), so its goal day is left out of the target too.
  const targetDays =
    dependsOnManual(metric) && summary.pendingToday && today !== undefined
      ? goalDays.filter((d) => d.date !== today)
      : goalDays;
  const target = isSumMetric(metric)
    ? round2(targetDays.reduce((total, d) => total + d.dailyValue, 0))
    : lastDay.dailyValue;
  const value = metricValue(summary, metric);

  // Gray while a past day is pending, or when the only goal day is a
  // pending today (nothing complete to judge yet).
  const status: GoalStatus =
    (dependsOnManual(metric) && (summary.pendingDays > 0 || targetDays.length === 0)) ||
    value === null
      ? "gray"
      : goalStatusForBand(direction, target, value);

  return { metric, direction, target, value, status };
}

function todayInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseDateParts(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

function toUTCDate(s: string): Date {
  const { y, m, d } = parseDateParts(s);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUTCDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(s: string, delta: number): string {
  const date = toUTCDate(s);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatUTCDate(date);
}

function startOfMonth(s: string): string {
  const { y, m } = parseDateParts(s);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function endOfMonth(y: number, m: number): string {
  // Date.UTC(y, m, 0) lands on the last day of month `m` (1-indexed).
  return formatUTCDate(new Date(Date.UTC(y, m, 0)));
}

function daysBetweenInclusive(from: string, to: string): number {
  const diff = (toUTCDate(to).getTime() - toUTCDate(from).getTime()) / 86_400_000;
  return diff + 1;
}

export function presetRange(p: Exclude<PeriodPreset, "custom">, now: Date): DateRange {
  const today = todayInSaoPaulo(now);
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "month":
      return { from: startOfMonth(today), to: today };
  }
}

/** True when the range is exactly one calendar month (1st to last day). */
export function isWholeMonth(r: DateRange): boolean {
  const { y, m, d } = parseDateParts(r.from);
  return d === 1 && r.to === endOfMonth(y, m);
}

export function compareRange(r: DateRange, mode: CompareMode, preset: PeriodPreset): DateRange {
  if (mode === "last_week" || mode === "same_weekday_last_week") {
    return { from: addDays(r.from, -7), to: addDays(r.to, -7) };
  }

  // mode === "previous"
  // The "Mês" preset, or any range that is exactly one calendar month,
  // compares with the previous calendar month (cut at the same day only while
  // the current month is in progress).
  if (preset === "month" || isWholeMonth(r)) {
    const { y, m } = parseDateParts(r.from);
    let prevYear = y;
    let prevMonth = m - 1;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const prevFrom = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const lastDayOfPrevMonth = endOfMonth(prevYear, prevMonth);
    const sameDayNumber = isWholeMonth(r) ? 31 : parseDateParts(r.to).d;
    const lastDayNumber = parseDateParts(lastDayOfPrevMonth).d;
    const prevTo =
      sameDayNumber <= lastDayNumber
        ? `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(sameDayNumber).padStart(2, "0")}`
        : lastDayOfPrevMonth;
    return { from: prevFrom, to: prevTo };
  }

  const length = daysBetweenInclusive(r.from, r.to);
  const to = addDays(r.from, -1);
  const from = addDays(to, -(length - 1));
  return { from, to };
}

/** Relative change; divides by |prev| so improving from a negative is positive. */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** Difference of two ratios (e.g. ROI) in percentage points: 0.3 vs 0.2 → 10. */
export function ppChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null) return null;
  return (cur - prev) * 100;
}
