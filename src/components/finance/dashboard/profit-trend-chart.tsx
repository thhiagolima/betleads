// "Lucro em 12 meses" (spec §5.4, §6). Tenant scope: one bar per month,
// negative months red, the month in progress lighter and a month with pending
// days dashed ("incompleto" in the tooltip). Group/all scope: bars stacked by
// house (byTenant). CHART_SERIES has five hues and a hue is never cycled, so
// past four houses the smaller ones fold into "Outras casas". The tooltip
// shows the month's lucro, anúncios and ROI from the MonthPoint totals.
// A toggle switches the metric (spec §3.2.4): Lucro líquido | Net |
// Depósitos. Only the profit is split by house (byTenant), so Net and
// Depósitos are one bar per month in every scope.
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  betleadsMissingNote,
  formatBRL,
  formatRatio,
  monthLabel,
} from "@/components/finance/format";
import {
  CHART_COLORS,
  CHART_SERIES,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartTooltipStyle,
} from "@/lib/chart-theme";
import type { MonthPoint } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

export type TrendMetric = "cashResult" | "net" | "depositAmount";

const METRICS: { key: TrendMetric; label: string }[] = [
  { key: "cashResult", label: "Lucro líquido" },
  { key: "net", label: "Net" },
  { key: "depositAmount", label: "Depósitos" },
];

/**
 * The chart card's title: "(lucro líquido empilhado por casa)" only while the
 * bars are the profit stacked by house (group/all scope, Lucro líquido).
 */
export function trendChartTitle(stacked: boolean, metric: TrendMetric): string {
  return stacked && metric === "cashResult"
    ? "Últimos 12 meses (lucro líquido empilhado por casa)"
    : "Últimos 12 meses";
}

/** The month's value for the picked metric. */
export function trendValue(point: MonthPoint, metric: TrendMetric): number {
  return point[metric];
}

const MAX_NAMED_HOUSES = 4;
const OTHERS_KEY = "__outras";

type Series = { key: string; name: string; color: string };

/** Houses named in the stacked chart (largest absolute profit first) and the rest folded. */
function stackSeries(months: MonthPoint[], tenants: { id: string; nome: string }[]) {
  const weight = (id: string) =>
    months.reduce((total, point) => total + Math.abs(point.byTenant[id] ?? 0), 0);
  const ranked = [...tenants].sort((a, b) => weight(b.id) - weight(a.id));
  const fold = ranked.length > MAX_NAMED_HOUSES + 1;
  const named = fold ? ranked.slice(0, MAX_NAMED_HOUSES) : ranked;
  // Color follows the house's place in the name-sorted list, not its rank.
  const series: Series[] = tenants
    .filter((tenant) => named.includes(tenant))
    .map((tenant, index) => ({ key: tenant.id, name: tenant.nome, color: CHART_SERIES[index] }));
  if (fold) series.push({ key: OTHERS_KEY, name: "Outras casas", color: CHART_COLORS.muted });
  const namedIds = new Set(named.map((tenant) => tenant.id));
  return { series, namedIds };
}

type TooltipPayload = { payload?: MonthPoint & { label: string } };

function MonthTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div style={chartTooltipStyle} className="space-y-0.5 px-3 py-2">
      <p className="text-muted-foreground">
        {monthLabel(point.month, true)}
        {point.inProgress && " · em andamento"}
        {point.incomplete && " · incompleto"}
      </p>
      <p>Lucro líquido: {formatBRL(point.cashResult)}</p>
      <p>Net: {formatBRL(point.net)}</p>
      <p>Depósitos: {formatBRL(point.depositAmount)}</p>
      <p>Anúncios: {formatBRL(point.adSpend)}</p>
      <p>ROI: {formatRatio(point.roi)}</p>
    </div>
  );
}

export function ProfitTrendChart({
  months,
  tenants,
  stacked,
  betleadsSince,
  metric: controlledMetric,
  onMetricChange,
}: {
  months: MonthPoint[];
  /** Houses of the scope, sorted by name (dashboard.tenants). */
  tenants: { id: string; nome: string }[];
  /** Group/all scope: bars stacked by house. */
  stacked: boolean;
  betleadsSince: string | null;
  /** Controlled metric (the caller's title follows it); uncontrolled when omitted. */
  metric?: TrendMetric;
  onMetricChange?: (metric: TrendMetric) => void;
}) {
  const [ownMetric, setOwnMetric] = useState<TrendMetric>("cashResult");
  const metric = controlledMetric ?? ownMetric;
  const setMetric = (next: TrendMetric) => {
    setOwnMetric(next);
    onMetricChange?.(next);
  };

  if (!months.length) {
    return (
      <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        Sem dados para o gráfico.
      </p>
    );
  }

  // Only the profit has a per-house split.
  const byHouse = stacked && metric === "cashResult";
  const metricLabel = METRICS.find((item) => item.key === metric)?.label ?? "";
  const { series, namedIds } = stackSeries(months, tenants);
  const data = months.map((point) => {
    const row: Record<string, unknown> = {
      ...point,
      label: monthLabel(point.month),
      value: trendValue(point, metric),
    };
    if (byHouse) {
      let others = 0;
      for (const tenant of tenants) {
        const value = point.byTenant[tenant.id] ?? 0;
        if (namedIds.has(tenant.id)) row[tenant.id] = value;
        else others += value;
      }
      if (series.some((item) => item.key === OTHERS_KEY)) row[OTHERS_KEY] = others;
    }
    return row;
  });

  const missing = months.some((point) => point.betleadsMissing);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Métrica do gráfico">
        {METRICS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={metric === item.key}
            onClick={() => setMetric(item.key)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              metric === item.key
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} stackOffset={byHouse ? "sign" : undefined}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartAxisProps} />
            <YAxis
              {...chartAxisProps}
              width={88}
              tickFormatter={(value) => formatBRL(Number(value)).replace(/,00$/, "")}
            />
            <ReferenceLine y={0} stroke="var(--color-border)" />
            <Tooltip
              content={<MonthTooltip />}
              cursor={{ fill: "var(--color-secondary)", opacity: 0.5 }}
            />
            {byHouse ? (
              <>
                <Legend {...chartLegendProps} />
                {series.map((item) => (
                  <Bar
                    key={item.key}
                    dataKey={item.key}
                    name={item.name}
                    stackId="lucro"
                    fill={item.color}
                    stroke="var(--color-card)"
                    strokeWidth={1}
                  />
                ))}
              </>
            ) : (
              <Bar dataKey="value" name={metricLabel} radius={[4, 4, 0, 0]}>
                {months.map((point) => (
                  <Cell
                    key={point.month}
                    fill={
                      trendValue(point, metric) < 0 ? CHART_COLORS.danger : CHART_COLORS.primary
                    }
                    fillOpacity={point.inProgress ? 0.45 : 1}
                    stroke={point.incomplete ? CHART_COLORS.warning : undefined}
                    strokeDasharray={point.incomplete ? "4 3" : undefined}
                    strokeWidth={point.incomplete ? 1.5 : 0}
                  />
                ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {missing && (
        <p className="text-xs text-muted-foreground">{betleadsMissingNote(betleadsSince)}</p>
      )}
    </div>
  );
}
