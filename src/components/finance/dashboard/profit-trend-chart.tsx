// "Lucro em 12 meses" (spec §5.4, §6). Tenant scope: one bar per month,
// negative months red, the month in progress lighter and a month with pending
// days dashed ("incompleto" in the tooltip). Group/all scope: bars stacked by
// house (byTenant). CHART_SERIES has five hues and a hue is never cycled, so
// past four houses the smaller ones fold into "Outras casas". The tooltip
// shows the month's lucro, anúncios and ROI from the MonthPoint totals.
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
      <p>Lucro: {formatBRL(point.cashResult)}</p>
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
}: {
  months: MonthPoint[];
  /** Houses of the scope, sorted by name (dashboard.tenants). */
  tenants: { id: string; nome: string }[];
  /** Group/all scope: bars stacked by house. */
  stacked: boolean;
  betleadsSince: string | null;
}) {
  if (!months.length) {
    return (
      <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        Sem dados para o gráfico.
      </p>
    );
  }

  const { series, namedIds } = stackSeries(months, tenants);
  const data = months.map((point) => {
    const row: Record<string, unknown> = { ...point, label: monthLabel(point.month) };
    if (stacked) {
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
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} stackOffset={stacked ? "sign" : undefined}>
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
            {stacked ? (
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
              <Bar dataKey="cashResult" name="Lucro líquido" radius={[4, 4, 0, 0]}>
                {months.map((point) => (
                  <Cell
                    key={point.month}
                    fill={point.cashResult < 0 ? CHART_COLORS.danger : CHART_COLORS.primary}
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
