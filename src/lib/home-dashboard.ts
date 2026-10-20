import type { DateRange } from "react-day-picker";

export type PeriodPreset =
  "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month" | "custom";

export const PERIOD_PRESETS: Array<{ value: Exclude<PeriodPreset, "custom">; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "this_month", label: "Este mês" },
  { value: "last_month", label: "Mês passado" },
];

const DAY_MS = 86_400_000;

export function periodRange(
  preset: Exclude<PeriodPreset, "custom">,
  now: Date = new Date(),
): DateRange {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  if (preset === "today") return { from: now, to: now };
  if (preset === "yesterday") {
    const d = new Date(now.getTime() - DAY_MS);
    return { from: d, to: d };
  }
  if (preset === "30d") return { from: new Date(now.getTime() - 29 * DAY_MS), to: now };
  if (preset === "this_month") return { from: startOfMonth, to: now };
  if (preset === "last_month") return { from: lastMonthStart, to: lastMonthEnd };
  return { from: new Date(now.getTime() - 6 * DAY_MS), to: now };
}

export function fmtPct(value: number, digits = 1) {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export type Trend = {
  direction: "up" | "down" | "flat";
  /** Tone of the change for the business: more deposits is good. */
  tone: "positive" | "negative" | "neutral";
  label: string;
};

/**
 * Arrow, tone and label for a period-over-period change. `unit` "pct" is a
 * relative change (12,4%); "pp" is a difference of two rates (1,2 p.p.).
 * Returns null when there is nothing honest to show (no number, NaN, ∞).
 */
export function trendDisplay(
  value: number | null | undefined,
  unit: "pct" | "pp" = "pct",
): Trend | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  const abs = Math.abs(rounded).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const suffix = unit === "pp" ? " p.p." : "%";
  if (rounded > 0) return { direction: "up", tone: "positive", label: `↑ ${abs}${suffix}` };
  if (rounded < 0) return { direction: "down", tone: "negative", label: `↓ ${abs}${suffix}` };
  return { direction: "flat", tone: "neutral", label: `→ 0,0${suffix}` };
}

/** Hour of the day in Brasília, regardless of the browser's time zone. */
export function brtHour(now: Date = new Date()): number {
  return (
    Number(
      now.toLocaleString("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hour12: false,
      }),
    ) % 24
  );
}

export function greetingFor(now: Date = new Date()): string {
  const hour = brtHour(now);
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}
