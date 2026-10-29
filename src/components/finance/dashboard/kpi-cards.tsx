// KPI cards of the Financeiro painel (spec §5.3): three highlighted (Lucro
// líquido, ROI, Anúncios) and five supporting (Depósitos, Saques, Net, FTDs,
// Custo por FTD), each with its variation vs the compared window. ROI varies
// in percentage points; the cards where going up is bad (Anúncios, Saques,
// Custo por FTD) invert the color.
import {
  formatBRL,
  formatInt,
  formatPct,
  formatPp,
  formatRatio,
} from "@/components/finance/format";
import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { TermTooltip } from "@/components/finance/term-tooltip";
import { pctChange, ppChange } from "@/lib/finance/calc";
import type { PeriodSummary } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

type KpiKey =
  "cashResult" | "roi" | "adSpend" | "deposits" | "withdrawals" | "net" | "ftds" | "costPerFtd";

type Kpi = {
  key: KpiKey;
  label: string;
  /** The FINANCE_TERMS entry this card's number maps to, if any; renders a TermTooltip next to the title. */
  term?: TermKey;
  format: "money" | "int" | "ratio";
  pick: (summary: PeriodSummary) => number | null;
  highlight?: boolean;
  /** True when an increase is bad (cost-shaped metric): color is inverted. */
  invert?: boolean;
};

const KPIS: Kpi[] = [
  {
    key: "cashResult",
    label: FINANCE_TERMS.cashResult.label,
    term: "cashResult",
    format: "money",
    pick: (s) => s.cashResult,
    highlight: true,
  },
  {
    key: "roi",
    label: FINANCE_TERMS.roi.label,
    term: "roi",
    format: "ratio",
    pick: (s) => s.roi,
    highlight: true,
  },
  {
    key: "adSpend",
    label: "Investido em anúncios",
    format: "money",
    pick: (s) => s.adSpend,
    highlight: true,
    invert: true,
  },
  { key: "deposits", label: "Depósitos", format: "money", pick: (s) => s.depositAmount },
  {
    key: "withdrawals",
    label: "Saques",
    format: "money",
    pick: (s) => s.withdrawalAmount,
    invert: true,
  },
  {
    key: "net",
    label: FINANCE_TERMS.net.label,
    term: "net",
    format: "money",
    pick: (s) => s.net,
  },
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

/** Spec §4.3: the plan fee only enters a closed month (other costs enter by date). */
export const NO_FEE_NOTE = "Resultado sem a mensalidade do mês (entra no fechamento do mês).";

/** Rule 6 of the GGR do mês: the window holds only part of a month whose GGR came as a total. */
export const GGR_ESTIMATED_NOTE = "GGR estimado a partir do total do mês.";

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
  const renderCard = (kpi: Kpi) => {
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
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
          {kpi.term && <TermTooltip term={kpi.term} />}
        </p>
        <p className={cn("font-semibold", kpi.highlight ? "text-2xl" : "text-xl")}>
          {formatValue(kpi.format, value)}
        </p>
        <Variation kpi={kpi} current={value} previous={kpi.pick(previous)} />
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div data-kpi-row="highlight" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {KPIS.filter((kpi) => kpi.highlight).map(renderCard)}
      </div>
      <div data-kpi-row="support" className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {KPIS.filter((kpi) => !kpi.highlight).map(renderCard)}
      </div>
      {current.betleadsFee === null && (
        <p data-note="no-fee" className="text-xs text-muted-foreground">
          {NO_FEE_NOTE}
        </p>
      )}
      {current.ggrEstimated && (
        <p data-note="ggr-estimated" className="text-xs text-muted-foreground">
          {GGR_ESTIMATED_NOTE}
        </p>
      )}
    </div>
  );
}
