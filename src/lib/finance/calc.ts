import type {
  CompareMode,
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

export function summarize(days: FinanceDay[], otherCosts: number | null): PeriodSummary {
  const completeDays = days.filter((d) => !d.pending);

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

  const cashResult = round2(rawCashResult - (otherCosts ?? 0));
  const roi = completeAdSpend === 0 ? null : cashResult / completeAdSpend;
  const costPerRegistration = registrations === 0 ? null : adSpend / registrations;
  const costPerFtd = ftds === 0 ? null : adSpend / ftds;
  const avgDailyCashResult = completeDays.length === 0 ? null : cashResult / completeDays.length;

  return {
    days: days.length,
    pendingDays: days.length - completeDays.length,
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
  };
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
): GoalEvaluation | null {
  if (goalDays.length === 0) return null;

  const metric = goalDays[0].metric;
  const lastDay = lastGoalDayUpTo(goalDays, range.to);
  const direction = lastDay.direction;
  const target = isSumMetric(metric)
    ? round2(goalDays.reduce((total, d) => total + d.dailyValue, 0))
    : lastDay.dailyValue;
  const value = metricValue(summary, metric);

  const status: GoalStatus =
    (dependsOnManual(metric) && summary.pendingDays > 0) || value === null
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

export function compareRange(r: DateRange, mode: CompareMode, preset: PeriodPreset): DateRange {
  if (mode === "last_week" || mode === "same_weekday_last_week") {
    return { from: addDays(r.from, -7), to: addDays(r.to, -7) };
  }

  // mode === "previous"
  if (preset === "month") {
    const { y, m } = parseDateParts(r.from);
    let prevYear = y;
    let prevMonth = m - 1;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const prevFrom = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const lastDayOfPrevMonth = endOfMonth(prevYear, prevMonth);
    const sameDayNumber = parseDateParts(r.to).d;
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

export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / prev;
}
