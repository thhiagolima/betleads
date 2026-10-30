// "Lucro em 12 meses" (spec §5.4, §6). Tenant scope: one bar per month with
// its value on the bar, negative months red, zero centered (symmetric domain)
// when the series has negatives, a month with no data drawn as a faint dash,
// the month in progress labeled bold, and the in-progress or incomplete
// months lighter ("em andamento"/"incompleto" in the tooltip). When fewer
// than 3 months have data a hint says where the data starts. The header
// holds the title and the metric toggle (a segmented control). Group/all
// scope: bars stacked by
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
  LabelList,
  Legend,
  Rectangle,
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

import { emptyMonth, trendStartHint } from "./display";

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

/**
 * The value axis: symmetric around zero when anything is negative (zero in
 * the middle), else from zero to the largest value.
 */
export function trendDomain(values: number[]): [number, number] {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (min < 0) {
    const extent = Math.max(max, -min);
    return [-extent, extent];
  }
  return [0, max || 1];
}

const shortBRL = (value: number) => formatBRL(value).replace(/,\d\d$/, "");

type BarShapeProps = { x: number; y: number; width: number; height: number; index: number };

type LabelProps = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
  index?: number;
};

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
  title,
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
  /** Header title; trendChartTitle(stacked, metric) when omitted. */
  title?: string;
}) {
  const [ownMetric, setOwnMetric] = useState<TrendMetric>("cashResult");
  const metric = controlledMetric ?? ownMetric;
  const setMetric = (next: TrendMetric) => {
    setOwnMetric(next);
    onMetricChange?.(next);
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold leading-tight">
        {title ?? trendChartTitle(stacked, metric)}
      </h2>
      <div
        className="inline-flex gap-0.5 rounded-lg border border-border bg-secondary/40 p-0.5"
        role="group"
        aria-label="Métrica do gráfico"
      >
        {METRICS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={metric === item.key}
            onClick={() => setMetric(item.key)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              metric === item.key
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (!months.length) {
    return (
      <div className="space-y-4">
        {header}
        <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Sem dados para o gráfico.
        </p>
      </div>
    );
  }

  // Only the profit has a per-house split.
  const byHouse = stacked && metric === "cashResult";
  const metricLabel = METRICS.find((item) => item.key === metric)?.label ?? "";
  const { series, namedIds } = stackSeries(months, tenants);
  const empties = months.map((point) => !byHouse && emptyMonth(point, betleadsSince));
  const data = months.map((point, index) => {
    const row: Record<string, unknown> = {
      ...point,
      label: monthLabel(point.month),
      value: trendValue(point, metric),
      empty: empties[index],
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

  // Stacked bars reach the sum of each sign's parts.
  const extents = byHouse
    ? months.flatMap((point) => {
        const parts = Object.values(point.byTenant);
        return [
          parts.filter((part) => part > 0).reduce((sum, part) => sum + part, 0),
          parts.filter((part) => part < 0).reduce((sum, part) => sum + part, 0),
        ];
      })
    : months.map((point) => trendValue(point, metric));
  const [low, high] = trendDomain(extents);
  // Headroom for the value labels.
  const domain: [number, number] = [low * 1.2, high * 1.2];

  const missing = months.some((point) => point.betleadsMissing);
  const hint = stacked ? null : trendStartHint(months, betleadsSince);

  return (
    <div className="space-y-3">
      {header}
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            stackOffset={byHouse ? "sign" : undefined}
            margin={{ top: 16, right: 4, bottom: 4, left: 4 }}
          >
            <CartesianGrid {...chartGridProps} />
            <XAxis
              dataKey="label"
              {...chartAxisProps}
              interval={0}
              tick={(props: {
                x: number;
                y: number;
                index: number;
                payload: { value: string };
              }) => {
                const current = months[props.index]?.inProgress;
                return (
                  <text
                    x={props.x}
                    y={props.y}
                    dy={12}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={current ? 600 : 400}
                    fill={current ? "var(--color-foreground)" : "var(--color-muted-foreground)"}
                  >
                    {props.payload.value}
                  </text>
                );
              }}
            />
            <YAxis
              {...chartAxisProps}
              hide={!byHouse}
              width={88}
              domain={domain}
              allowDataOverflow
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
              <Bar
                dataKey="value"
                name={metricLabel}
                radius={4}
                maxBarSize={56}
                shape={(raw: unknown) => {
                  const props = raw as BarShapeProps;
                  // No data: a faint dash on the zero line instead of a bar.
                  if (empties[props.index]) {
                    return (
                      <rect
                        x={props.x + props.width * 0.3}
                        y={props.y - 1}
                        width={props.width * 0.4}
                        height={2}
                        rx={1}
                        fill="var(--color-border)"
                      />
                    );
                  }
                  return <Rectangle {...(raw as object)} radius={4} />;
                }}
              >
                {months.map((point) => (
                  <Cell
                    key={point.month}
                    fill={
                      trendValue(point, metric) < 0 ? CHART_COLORS.danger : CHART_COLORS.primary
                    }
                    fillOpacity={point.inProgress || point.incomplete ? 0.6 : 1}
                  />
                ))}
                <LabelList
                  dataKey="value"
                  content={(props: LabelProps) => {
                    if (props.index === undefined || empties[props.index]) return null;
                    const value = Number(props.value);
                    const x = Number(props.x) + Number(props.width) / 2;
                    const y = Number(props.y);
                    const height = Number(props.height);
                    const top = Math.min(y, y + height);
                    const bottom = Math.max(y, y + height);
                    return (
                      <text
                        x={x}
                        y={value < 0 ? bottom + 14 : top - 6}
                        textAnchor="middle"
                        fontSize={12}
                        fontWeight={600}
                        fill={value < 0 ? CHART_COLORS.danger : "var(--color-foreground)"}
                      >
                        {shortBRL(value)}
                      </text>
                    );
                  }}
                />
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}
      {missing && (
        <p className="text-xs text-muted-foreground">{betleadsMissingNote(betleadsSince)}</p>
      )}
    </div>
  );
}
