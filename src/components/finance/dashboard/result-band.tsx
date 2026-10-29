// Faixa de resultado (spec §3.2.1): Lucro líquido, Margem, Retorno (ROI) and
// Anúncios, each with its variation vs the compared window and the "como
// calculamos" tooltip. The ROI also shows the previous calendar month's ROI
// (roiReference, spec §4.5) as a fixed reference. Relies on a TooltipProvider
// above it (the dashboard root).
import type { ReactNode } from "react";

import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { formatBRL, formatPct, formatRatio } from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { DateRange, FinanceKpis, PeriodSummary } from "@/lib/finance/types";

import { Variation } from "./variation";

function ResultCard({
  id,
  label,
  term,
  value,
  variation,
  footer,
}: {
  id: string;
  label: string;
  term?: TermKey;
  value: string;
  variation: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div data-result={id} className="rounded-lg border border-primary/50 bg-primary/5 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
        {term && <TermTooltip term={term} />}
      </p>
      <p className="text-2xl font-semibold">{value}</p>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {variation}
        {footer}
      </div>
    </div>
  );
}

export function ResultBand({
  current,
  previous,
  kpis,
  roiReference,
  houseCount,
}: {
  current: PeriodSummary;
  previous: PeriodSummary;
  kpis: { current: FinanceKpis; previous: FinanceKpis };
  roiReference: { roi: number | null; range: DateRange };
  /** Group/all scope: shown as "Lucro líquido (N casas)". */
  houseCount?: number;
}) {
  const profitLabel =
    houseCount !== undefined && houseCount > 1
      ? `${FINANCE_TERMS.cashResult.label} (${houseCount} casas)`
      : FINANCE_TERMS.cashResult.label;

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <ResultCard
        id="cashResult"
        label={profitLabel}
        term="cashResult"
        value={formatBRL(current.cashResult)}
        variation={<Variation current={current.cashResult} previous={previous.cashResult} />}
      />
      <ResultCard
        id="margin"
        label={FINANCE_TERMS.margin.label}
        term="margin"
        value={formatPct(kpis.current.margin)}
        variation={
          <Variation current={kpis.current.margin} previous={kpis.previous.margin} points />
        }
      />
      <ResultCard
        id="roi"
        label={FINANCE_TERMS.roi.label}
        term="roi"
        value={formatRatio(current.roi)}
        variation={<Variation current={current.roi} previous={previous.roi} points />}
        footer={
          <span className="text-xs text-muted-foreground">
            mês anterior: {formatRatio(roiReference.roi)}
          </span>
        }
      />
      <ResultCard
        id="adSpend"
        label="Anúncios"
        value={formatBRL(current.adSpend)}
        variation={<Variation current={current.adSpend} previous={previous.adSpend} invert />}
      />
    </div>
  );
}
