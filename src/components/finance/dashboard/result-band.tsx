// Faixa de resultado (spec §3.2.1): Lucro líquido is the main card (wider,
// larger value, tinted by sign); Margem, Retorno (ROI) and Anúncios follow.
// Each card has a small uppercase label with the "como calculamos" tooltip,
// the value and one muted meta line: the variation when there is something
// to compare, else a short reason. The ROI shows the previous calendar
// month's ROI (roiReference, spec §4.5) as a fixed reference. Relies on a
// TooltipProvider above it (the dashboard root).
import type { ReactNode } from "react";

import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { formatBRL, formatPct, formatRatio } from "@/components/finance/format";
import { TermTooltip } from "@/components/finance/term-tooltip";
import type { DateRange, FinanceKpis, PeriodSummary } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

import { periodHasData } from "./display";
import { hasVariation, Variation } from "./variation";

export const NO_COMPARE_TEXT = "Sem mês anterior para comparar";

const signClass = (value: number | null) =>
  value === null || value === 0 ? undefined : value < 0 ? "text-rose-400" : "text-emerald-400";

function ResultCard({
  id,
  label,
  term,
  value,
  valueClassName,
  meta,
  main = false,
  tint,
}: {
  id: string;
  label: string;
  term?: TermKey;
  value: string;
  valueClassName?: string;
  meta: ReactNode;
  main?: boolean;
  tint?: "positive" | "negative";
}) {
  return (
    <div
      data-result={id}
      className={cn(
        "min-w-0 rounded-[14px] border border-border bg-card/80 px-5 py-[18px]",
        main && "col-span-2 lg:col-span-1",
        tint === "negative" && "border-rose-500/30 bg-rose-500/[0.06]",
        tint === "positive" && "border-emerald-500/30 bg-emerald-500/[0.06]",
      )}
    >
      <p className="flex items-center text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
        {term && <TermTooltip term={term} />}
      </p>
      <p
        className={cn(
          "mt-2.5 font-bold leading-tight tracking-tight tabular-nums",
          main ? "text-[32px] sm:text-[40px]" : "text-[26px] sm:text-[30px]",
          valueClassName,
        )}
      >
        {value}
      </p>
      <div className="mt-2 text-xs text-muted-foreground/80">{meta}</div>
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
  const hasPrevious = periodHasData(previous);

  const profitMeta = hasVariation(current.cashResult, previous.cashResult, hasPrevious) ? (
    <Variation
      current={current.cashResult}
      previous={previous.cashResult}
      hasPrevious={hasPrevious}
    />
  ) : (
    NO_COMPARE_TEXT
  );

  const adsMeta = hasVariation(current.adSpend, previous.adSpend, hasPrevious) ? (
    <Variation
      current={current.adSpend}
      previous={previous.adSpend}
      hasPrevious={hasPrevious}
      invert
    />
  ) : current.adSpend === 0 && current.pendingDays > 0 ? (
    "Nenhum dia lançado"
  ) : (
    NO_COMPARE_TEXT
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
      <ResultCard
        id="cashResult"
        main
        label={profitLabel}
        term="cashResult"
        value={formatBRL(current.cashResult)}
        valueClassName={signClass(current.cashResult)}
        tint={current.cashResult < 0 ? "negative" : current.cashResult > 0 ? "positive" : undefined}
        meta={profitMeta}
      />
      <ResultCard
        id="margin"
        label={FINANCE_TERMS.margin.label}
        term="margin"
        value={kpis.current.margin === null ? "—" : formatPct(kpis.current.margin)}
        valueClassName={
          kpis.current.margin === null ? "text-muted-foreground" : signClass(kpis.current.margin)
        }
        meta="lucro ÷ net"
      />
      <ResultCard
        id="roi"
        label={FINANCE_TERMS.roi.label}
        term="roi"
        value={current.roi === null ? "—" : formatRatio(current.roi)}
        valueClassName={current.roi === null ? "text-muted-foreground" : undefined}
        meta={
          current.roi === null
            ? "Sem anúncios no período"
            : `mês anterior: ${formatRatio(roiReference.roi)}`
        }
      />
      <ResultCard id="adSpend" label="Anúncios" value={formatBRL(current.adSpend)} meta={adsMeta} />
    </div>
  );
}
