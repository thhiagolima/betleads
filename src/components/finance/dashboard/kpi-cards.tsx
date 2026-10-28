// KPI cards of the Financeiro painel (spec §5.3): three highlighted (Lucro
// líquido, ROI, Anúncios) and three supporting (Net, FTDs, Custo por FTD),
// each with its variation vs the compared window. ROI varies in percentage
// points; the cost-shaped cards (Anúncios, Custo por FTD) invert the color.
import {
  formatBRL,
  formatInt,
  formatPct,
  formatPp,
  formatRatio,
} from "@/components/finance/format";
import { pctChange, ppChange } from "@/lib/finance/calc";
import type { PeriodSummary } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

type KpiKey = "cashResult" | "roi" | "adSpend" | "net" | "ftds" | "costPerFtd";

type Kpi = {
  key: KpiKey;
  label: string;
  format: "money" | "int" | "ratio";
  pick: (summary: PeriodSummary) => number | null;
  highlight?: boolean;
  /** True when an increase is bad (cost-shaped metric): color is inverted. */
  invert?: boolean;
};

const KPIS: Kpi[] = [
  {
    key: "cashResult",
    label: "Lucro líquido",
    format: "money",
    pick: (s) => s.cashResult,
    highlight: true,
  },
  { key: "roi", label: "Retorno (ROI)", format: "ratio", pick: (s) => s.roi, highlight: true },
  {
    key: "adSpend",
    label: "Investido em anúncios",
    format: "money",
    pick: (s) => s.adSpend,
    highlight: true,
    invert: true,
  },
  { key: "net", label: "Net (depósitos − saques)", format: "money", pick: (s) => s.net },
  { key: "ftds", label: "FTDs", format: "int", pick: (s) => s.ftds },
  {
    key: "costPerFtd",
    label: "Custo por FTD",
    format: "money",
    pick: (s) => s.costPerFtd,
    invert: true,
  },
];

function formatValue(format: Kpi["format"], value: number | null) {
  if (format === "money") return formatBRL(value);
  if (format === "ratio") return formatRatio(value);
  return formatInt(value);
}

function Variation({
  kpi,
  current,
  previous,
}: {
  kpi: Kpi;
  current: number | null;
  previous: number | null;
}) {
  const ratio = kpi.format === "ratio";
  const change = ratio ? ppChange(current, previous) : pctChange(current, previous);
  if (change === null) return <span className="text-xs text-muted-foreground">n.a.</span>;
  const good = kpi.invert ? change <= 0 : change >= 0;
  return (
    <span className={cn("text-xs", good ? "text-emerald-400" : "text-rose-400")}>
      {ratio ? formatPp(change) : `${change >= 0 ? "▲" : "▼"} ${formatPct(Math.abs(change))}`}
    </span>
  );
}

/** Spec §5: other costs and the plan fee only enter a closed month. */
export const NO_OTHER_COSTS_NOTE =
  "Resultado sem outros custos e mensalidade do mês (só entram em mês fechado).";

export function KpiCards({
  current,
  previous,
  houseCount,
}: {
  current: PeriodSummary;
  previous: PeriodSummary;
  /** Group/all scope: shown as "Lucro líquido (N casas)". */
  houseCount?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {KPIS.map((kpi) => {
          const value = kpi.pick(current);
          const label =
            kpi.key === "cashResult" && houseCount !== undefined && houseCount > 1
              ? `${kpi.label} (${houseCount} casas)`
              : kpi.label;
          return (
            <div
              key={kpi.key}
              data-kpi={kpi.key}
              className={cn(
                "rounded-lg border p-3",
                kpi.highlight ? "border-primary/50 bg-primary/5" : "border-border/40",
              )}
            >
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className={cn("font-semibold", kpi.highlight ? "text-2xl" : "text-xl")}>
                {formatValue(kpi.format, value)}
              </p>
              <Variation kpi={kpi} current={value} previous={kpi.pick(previous)} />
            </div>
          );
        })}
      </div>
      {current.otherCosts === null && (
        <p data-note="no-other-costs" className="text-xs text-muted-foreground">
          {NO_OTHER_COSTS_NOTE}
        </p>
      )}
    </div>
  );
}
