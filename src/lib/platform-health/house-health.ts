import { formatMoney } from "@/lib/currency";

/** One day of a house's acquisition/recovery numbers. */
export type HouseDay = { date: string; registrations: number; ftds: number; recovered: number };

/** A house's raw history fed into `summarizeHouse` (35 days: 28 base + 7 current). */
export type HouseHealthInput = { tenantId: string; name: string; moeda: string; days: HouseDay[] };

export type HealthLevel = "red" | "yellow" | "green" | "no_history";

export type HouseWindowTotals = {
  registrations: number;
  ftds: number;
  recovered: number;
  conversion: number | null;
};

export type HouseHealthRow = {
  tenantId: string;
  name: string;
  moeda: string;
  level: HealthLevel;
  reason: string | null;
  current: HouseWindowTotals;
  base: HouseWindowTotals; // base = média semanal
  deltas: {
    registrationsPct: number | null;
    ftdsPct: number | null;
    conversionPts: number | null;
    recoveredPct: number | null;
  };
  /** Smallest delta among the metrics that passed their volume gate (§5.3); null when none did. */
  worstDelta: number | null;
};

export type HealthWindows = {
  current: { from: string; to: string };
  base: { from: string; to: string };
};

/** Thresholds driving the health levels (spec §5.3); kept as one named constant. */
export const HEALTH_THRESHOLDS = {
  redPct: -50,
  yellowPct: -25,
  redConvPts: -10,
  yellowConvPts: -5,
  minBaseRegistrations: 20,
  minBaseFtds: 10,
  minBaseRecovered: 500,
  /**
   * "Sem histórico" when fewer than this many base weeks go from the first
   * week with a cadastro to the end of the base (history starts late). Empty
   * weeks *after* an active one don't count against the house: they are a
   * drop, judged by the normal rules.
   */
  minHistoryWeeks: 3,
} as const;

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

/**
 * The two 7/28-day windows used to judge a house: `current` is the last
 * closed week (yesterday back 7 days) and `base` is the 4 weeks right before
 * it, used as the "normal week" baseline.
 */
export function healthWindows(todaySaoPaulo: string): HealthWindows {
  const currentTo = addDays(todaySaoPaulo, -1);
  const currentFrom = addDays(currentTo, -6);
  const baseTo = addDays(currentFrom, -1);
  const baseFrom = addDays(baseTo, -27);
  return { current: { from: currentFrom, to: currentTo }, base: { from: baseFrom, to: baseTo } };
}

type RawTotals = { registrations: number; ftds: number; recovered: number };

function sumDays(days: HouseDay[], from: string, to: string): RawTotals {
  let registrations = 0;
  let ftds = 0;
  let recovered = 0;
  for (const d of days) {
    if (d.date >= from && d.date <= to) {
      registrations += d.registrations;
      ftds += d.ftds;
      recovered += d.recovered;
    }
  }
  return { registrations, ftds, recovered };
}

function toTotals(sum: RawTotals): HouseWindowTotals {
  return {
    ...sum,
    conversion: sum.registrations === 0 ? null : (sum.ftds / sum.registrations) * 100,
  };
}

/** Percent change, `null` when there is no base to compare against. */
function pctDelta(current: number, base: number): number | null {
  return base === 0 ? null : ((current - base) / base) * 100;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("pt-BR");
}

function fmtPct1(n: number): string {
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function sign(n: number): string {
  return n < 0 ? "−" : "+";
}

function reasonForCount(label: string, pct: number, current: number, baseWeekly: number): string {
  return `${label} ${sign(pct)}${Math.abs(Math.round(pct))}% (${fmtInt(current)} vs ~${fmtInt(baseWeekly)}/semana)`;
}

function reasonForConversion(pts: number, currentConv: number, baseConv: number): string {
  return `Conversão ${sign(pts)}${Math.abs(Math.round(pts))} pts (${fmtPct1(currentConv)} vs ${fmtPct1(baseConv)})`;
}

function reasonForRecovered(
  pct: number,
  current: number,
  baseWeekly: number,
  moeda: string,
): string {
  return `Recuperação ${sign(pct)}${Math.abs(Math.round(pct))}% (${formatMoney(current, moeda, { decimals: 0 })} vs ~${formatMoney(baseWeekly, moeda, { decimals: 0 })}/semana)`;
}

function levelForPct(pct: number): Exclude<HealthLevel, "no_history"> {
  if (pct <= HEALTH_THRESHOLDS.redPct) return "red";
  if (pct <= HEALTH_THRESHOLDS.yellowPct) return "yellow";
  return "green";
}

function levelForPts(pts: number): Exclude<HealthLevel, "no_history"> {
  if (pts <= HEALTH_THRESHOLDS.redConvPts) return "red";
  if (pts <= HEALTH_THRESHOLDS.yellowConvPts) return "yellow";
  return "green";
}

const LEVEL_RANK: Record<Exclude<HealthLevel, "no_history">, number> = {
  red: 2,
  yellow: 1,
  green: 0,
};

type Metric = { value: number; level: Exclude<HealthLevel, "no_history">; message: () => string };

/**
 * Builds one house's health row from its 35-day history, or `null` when the
 * house had no movement at all in either window ("casa sem movimento" is
 * left out of the table entirely rather than shown as a row).
 */
export function summarizeHouse(
  input: HouseHealthInput,
  windows: HealthWindows,
  opts: { recoveryUnavailable?: boolean } = {},
): HouseHealthRow | null {
  const currentSum = sumDays(input.days, windows.current.from, windows.current.to);
  const baseSum = sumDays(input.days, windows.base.from, windows.base.to);

  const allZero =
    currentSum.registrations + currentSum.ftds + currentSum.recovered === 0 &&
    baseSum.registrations + baseSum.ftds + baseSum.recovered === 0;
  if (allZero) return null;

  const current = toTotals(currentSum);
  const base = toTotals({
    registrations: baseSum.registrations / 4,
    ftds: baseSum.ftds / 4,
    recovered: baseSum.recovered / 4,
  });

  // Base weeks oldest first; history = weeks from the first active one on.
  let firstActiveWeek = 4;
  for (let w = 0; w < 4; w++) {
    const weekFrom = addDays(windows.base.from, w * 7);
    const weekTo = addDays(weekFrom, 6);
    if (sumDays(input.days, weekFrom, weekTo).registrations > 0) {
      firstActiveWeek = w;
      break;
    }
  }
  const historyWeeks = 4 - firstActiveWeek;

  if (historyWeeks < HEALTH_THRESHOLDS.minHistoryWeeks) {
    return {
      tenantId: input.tenantId,
      name: input.name,
      moeda: input.moeda,
      level: "no_history",
      reason: null,
      current,
      base,
      deltas: { registrationsPct: null, ftdsPct: null, conversionPts: null, recoveredPct: null },
      worstDelta: null,
    };
  }

  const registrationsPct = pctDelta(current.registrations, base.registrations);
  const ftdsPct = pctDelta(current.ftds, base.ftds);
  // finance_activity_days failed: recovery is unknown, not zero.
  const recoveredPct = opts.recoveryUnavailable
    ? null
    : pctDelta(current.recovered, base.recovered);
  const conversionPts =
    current.conversion === null || base.conversion === null
      ? null
      : current.conversion - base.conversion;

  const metrics: Metric[] = [];
  if (registrationsPct !== null && base.registrations >= HEALTH_THRESHOLDS.minBaseRegistrations) {
    metrics.push({
      value: registrationsPct,
      level: levelForPct(registrationsPct),
      message: () =>
        reasonForCount("Cadastros", registrationsPct, current.registrations, base.registrations),
    });
  }
  if (ftdsPct !== null && base.ftds >= HEALTH_THRESHOLDS.minBaseFtds) {
    metrics.push({
      value: ftdsPct,
      level: levelForPct(ftdsPct),
      message: () => reasonForCount("FTDs", ftdsPct, current.ftds, base.ftds),
    });
  }
  if (conversionPts !== null && base.registrations >= HEALTH_THRESHOLDS.minBaseRegistrations) {
    metrics.push({
      value: conversionPts,
      level: levelForPts(conversionPts),
      message: () =>
        reasonForConversion(conversionPts, current.conversion as number, base.conversion as number),
    });
  }
  if (recoveredPct !== null && base.recovered >= HEALTH_THRESHOLDS.minBaseRecovered) {
    metrics.push({
      value: recoveredPct,
      level: levelForPct(recoveredPct),
      message: () =>
        reasonForRecovered(recoveredPct, current.recovered, base.recovered, input.moeda),
    });
  }

  let level: HealthLevel = "green";
  let reason: string | null = null;
  let worstDelta: number | null = null;
  if (metrics.length > 0) {
    const worst = metrics.reduce((best, m) => {
      if (LEVEL_RANK[m.level] > LEVEL_RANK[best.level]) return m;
      if (LEVEL_RANK[m.level] === LEVEL_RANK[best.level] && m.value < best.value) return m;
      return best;
    });
    level = worst.level;
    reason = level === "green" ? null : worst.message();
    worstDelta = Math.min(...metrics.map((m) => m.value));
  }

  return {
    tenantId: input.tenantId,
    name: input.name,
    moeda: input.moeda,
    level,
    reason,
    current,
    base,
    deltas: { registrationsPct, ftdsPct, conversionPts, recoveredPct },
    worstDelta,
  };
}

const GROUP_RANK: Record<HealthLevel, number> = { red: 0, yellow: 1, green: 2, no_history: 3 };

/**
 * Red, then yellow, then green, then no_history; within a group, the worst
 * drop first — using `worstDelta` (only the metrics that passed their volume
 * gate), not the raw `deltas`, since a gated-out metric "não vale" (brief:
 * "menor delta entre as métricas que valem"). Rows with no counted metric
 * (worstDelta null) sort last within their group.
 */
export function sortHouses(rows: HouseHealthRow[]): HouseHealthRow[] {
  return [...rows].sort((a, b) => {
    if (GROUP_RANK[a.level] !== GROUP_RANK[b.level])
      return GROUP_RANK[a.level] - GROUP_RANK[b.level];
    const aw = a.worstDelta ?? Infinity;
    const bw = b.worstDelta ?? Infinity;
    return aw - bw;
  });
}
