import { useEffect, useState, type CSSProperties } from "react";

import type { MoneyFormatOptions } from "@/lib/currency";

/**
 * One chart look for the whole app (the one the Início uses). Recharts takes CSS
 * variables directly; the tokens are oklch, so never wrap them in hsl().
 */
export const CHART_COLORS = {
  primary: "var(--color-chart-1)",
  violet: "var(--color-chart-2)",
  cyan: "var(--color-chart-3)",
  green: "var(--color-chart-4)",
  orange: "var(--color-chart-5)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
  muted: "var(--color-muted-foreground)",
} as const;

/** Series colours in order, for charts with several lines or bars. */
export const CHART_SERIES = [
  CHART_COLORS.primary,
  CHART_COLORS.orange,
  CHART_COLORS.green,
  CHART_COLORS.violet,
  CHART_COLORS.cyan,
] as const;

export const chartTooltipStyle: CSSProperties = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
};

export const chartTooltipProps = {
  contentStyle: chartTooltipStyle,
  labelStyle: { color: "var(--color-muted-foreground)" },
  cursor: { fill: "var(--color-secondary)", opacity: 0.5 },
} as const;

/** Spread on <XAxis>/<YAxis>. */
export const chartAxisProps = {
  stroke: "var(--color-muted-foreground)",
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

/** Spread on <CartesianGrid>. */
export const chartGridProps = {
  stroke: "var(--color-border)",
  vertical: false,
} as const;

/** Spread on <Legend>: Recharts defaults to 16px. */
export const chartLegendProps = {
  wrapperStyle: { fontSize: 12, paddingTop: 8 },
  iconSize: 10,
} as const;

/** Phones (below Tailwind `sm`): charts get compact axes and drop secondary axes. */
const COMPACT_CHART_QUERY = "(max-width: 639px)";

export function useCompactCharts(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(COMPACT_CHART_QUERY);
    const sync = () => setCompact(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
  return compact;
}

type MoneyFormatter = (value: number | null | undefined, options?: MoneyFormatOptions) => string;

/**
 * Spread on a money <YAxis> (after `chartAxisProps`): full values on desktop,
 * compact ("R$ 1,2 mil") and a narrower axis on phones.
 */
export function moneyAxisProps(money: MoneyFormatter, compact: boolean, width = 78) {
  return {
    tickFormatter: (value: unknown) =>
      money(Number(value), compact ? { compact: true } : undefined),
    width: compact ? 56 : width,
  };
}
