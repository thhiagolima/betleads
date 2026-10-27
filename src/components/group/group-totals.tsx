// Six KPI cards of the group panel (spec §6): group totals with the %
// change vs the compared window. The totals already come from
// getGroupOverview as a sum over every house's days, never an average.
// Saques and Anúncios are cost-shaped metrics: going up is bad, so their
// color is inverted relative to Depósitos/Net/FTDs/Resultado (fix round 1,
// item 8).
import { formatBRL, formatInt, formatPct } from "@/components/finance/format";
import { pctChange } from "@/lib/finance/calc";
import type { PeriodSummary } from "@/lib/finance/types";

type Metric = {
  label: string;
  format: "money" | "int";
  pick: (summary: PeriodSummary) => number | null;
  /** True when an increase is bad (cost-shaped metric): color is inverted. */
  invert?: boolean;
};

const METRICS: Metric[] = [
  { label: "Depósitos", format: "money", pick: (s) => s.depositAmount },
  { label: "Saques", format: "money", pick: (s) => s.withdrawalAmount, invert: true },
  { label: "Net bruto", format: "money", pick: (s) => s.net },
  { label: "FTDs", format: "int", pick: (s) => s.ftds },
  { label: "Anúncios", format: "money", pick: (s) => s.adSpend, invert: true },
  { label: "Resultado caixa", format: "money", pick: (s) => s.cashResult },
];

export function GroupTotals({
  current,
  previous,
}: {
  current: PeriodSummary;
  previous: PeriodSummary;
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {METRICS.map((metric) => {
          const value = metric.pick(current);
          const change = pctChange(value, metric.pick(previous));
          const good = change === null ? null : metric.invert ? change <= 0 : change >= 0;
          return (
            <div key={metric.label} className="rounded-lg border border-border/40 p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {metric.label}
              </p>
              <p className="text-xl font-semibold">
                {metric.format === "money" ? formatBRL(value) : formatInt(value)}
              </p>
              {change !== null && (
                <span className={good ? "text-xs text-emerald-400" : "text-xs text-rose-400"}>
                  {change >= 0 ? "▲" : "▼"} {formatPct(Math.abs(change))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {current.pendingDays > 0 && (
        <p className="text-xs text-muted-foreground">
          {current.pendingDays} {current.pendingDays === 1 ? "dia pendente" : "dias pendentes"}
        </p>
      )}
    </div>
  );
}
