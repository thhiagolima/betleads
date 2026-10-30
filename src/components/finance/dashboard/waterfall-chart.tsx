// "Do depósito ao lucro" (spec §3.2.2): the waterfall from Depósitos down
// through Saques to Net, then the fees, Anúncios, Envios, Mensalidade and
// other costs down to Lucro líquido, as vertical columns (plain divs). Each
// step floats from its start to its end on one vertical scale
// (waterfallBars); the value sits above the column, or under it when the
// column hangs below zero. Entradas are blue-gray, saídas red, the subtotal
// slate and the total green or red by sign. On a phone the columns keep a
// minimum width (88px) and scroll sideways inside the card; the zero line
// and the axis span every column while scrolling.
import { formatBRL } from "@/components/finance/format";
import type { WaterfallStep } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

import { shortStepLabel } from "./display";

/** Spec §4.3: the plan fee only enters a closed month (other costs enter by date). */
export const NO_FEE_NOTE = "Resultado sem a mensalidade do mês (entra no fechamento do mês).";

export const HIDDEN_STEPS_NOTE = "Passos sem valor no período não aparecem.";

export type WaterfallTone = "in" | "down" | "subtotal" | "positive" | "negative";

export type WaterfallBar = {
  key: string;
  /** One-line step name (shortStepLabel). */
  label: string;
  /** The step's full name (tooltip). */
  fullLabel: string;
  /** Column bottom, in % of the plot height from its bottom. */
  bottomPct: number;
  /** Column height, in % of the plot height (always ≥ 0). */
  heightPct: number;
  /** Signed amount of the step: the change for down/up, the level for start/subtotal/total. */
  amount: number;
  tone: WaterfallTone;
  /** The column sits under zero: its value label goes below it. */
  labelBelow: boolean;
};

/** Where a step's column starts and ends (levels grow from zero). */
function span(step: WaterfallStep) {
  const moving = step.kind === "down" || step.kind === "up";
  const from = moving ? step.start : 0;
  return { from, to: step.end, low: Math.min(from, step.end), high: Math.max(from, step.end) };
}

/** The vertical domain: every column plus zero. */
function domain(steps: WaterfallStep[]) {
  let min = 0;
  let max = 0;
  for (const step of steps) {
    const { low, high } = span(step);
    min = Math.min(min, low);
    max = Math.max(max, high);
  }
  return { min, size: max - min || 1 };
}

/** The zero line, in % of the plot height from its bottom. */
export function waterfallZeroPct(steps: WaterfallStep[]): number {
  const { min, size } = domain(steps);
  return ((0 - min) / size) * 100;
}

/** The chart columns, one per step and in the steps' order. */
export function waterfallBars(steps: WaterfallStep[]): WaterfallBar[] {
  const { min, size } = domain(steps);
  return steps.map((step) => {
    const { from, to, low, high } = span(step);
    const tone: WaterfallTone =
      step.kind === "down"
        ? "down"
        : step.kind === "subtotal"
          ? "subtotal"
          : step.kind === "total"
            ? step.end < 0
              ? "negative"
              : "positive"
            : "in";
    return {
      key: step.key,
      label: shortStepLabel(step.label),
      fullLabel: step.label,
      bottomPct: ((low - min) / size) * 100,
      heightPct: ((high - low) / size) * 100,
      amount: Math.round((to - from) * 100) / 100,
      tone,
      labelBelow: high <= 0 && low < 0,
    };
  });
}

const TONE_BAR: Record<WaterfallTone, string> = {
  in: "bg-[#5b7fa6]",
  down: "bg-rose-400",
  subtotal: "bg-slate-500",
  positive: "bg-emerald-400",
  negative: "bg-rose-400",
};

const TONE_TEXT: Record<WaterfallTone, string> = {
  in: "text-foreground",
  down: "text-rose-400",
  subtotal: "text-foreground",
  positive: "text-emerald-400",
  negative: "text-rose-400",
};

const LEGEND: { label: string; className: string }[] = [
  { label: "Entradas", className: TONE_BAR.in },
  { label: "Saídas e custos", className: TONE_BAR.down },
  { label: "Subtotal", className: TONE_BAR.subtotal },
];

const shortBRL = (value: number) => formatBRL(value).replace(/,\d\d$/, "");

export function WaterfallChart({
  steps,
  withoutFee = false,
}: {
  steps: WaterfallStep[];
  /** The window is not a closed month: no Mensalidade step, say so. */
  withoutFee?: boolean;
}) {
  if (!steps.length) {
    return <p className="py-4 text-sm text-muted-foreground">Sem dados no período.</p>;
  }
  const bars = waterfallBars(steps);
  const zeroPct = waterfallZeroPct(steps);
  const columns = { gridTemplateColumns: `repeat(${bars.length}, minmax(88px, 1fr))` };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div className="w-max min-w-full">
          <div className="relative h-[260px] border-b border-border/70 py-7">
            <div className="relative h-full">
              <div
                aria-hidden
                className="absolute inset-x-0 border-t border-dashed border-border"
                style={{ bottom: `${zeroPct}%` }}
              />
              <div className="grid h-full gap-3 sm:gap-[18px]" style={columns}>
                {bars.map((bar) => (
                  <div key={bar.key} className="relative h-full">
                    <div
                      data-step={bar.key}
                      role="img"
                      aria-label={`${bar.fullLabel}: ${formatBRL(bar.amount)}`}
                      title={`${bar.fullLabel}: ${formatBRL(bar.amount)}`}
                      className={cn("absolute inset-x-[18%] rounded-md", TONE_BAR[bar.tone])}
                      style={{
                        bottom: `${bar.bottomPct}%`,
                        height: `${bar.heightPct}%`,
                        minHeight: 3,
                      }}
                    >
                      <span
                        className={cn(
                          "absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[13px] font-semibold tabular-nums",
                          bar.labelBelow ? "top-full mt-1" : "bottom-full mb-1",
                          TONE_TEXT[bar.tone],
                        )}
                      >
                        {shortBRL(bar.amount)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div
            className="grid gap-3 pt-3 text-center text-xs sm:gap-[18px] sm:text-[13px]"
            style={columns}
          >
            {bars.map((bar) => (
              <span
                key={bar.key}
                title={bar.fullLabel}
                className={cn(
                  "truncate whitespace-nowrap",
                  bar.tone === "positive" || bar.tone === "negative"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {bar.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 text-xs text-muted-foreground/80">
        {LEGEND.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <i aria-hidden className={cn("inline-block h-2.5 w-2.5 rounded-sm", item.className)} />
            {item.label}
          </span>
        ))}
        <span>{HIDDEN_STEPS_NOTE}</span>
      </div>
      {withoutFee && (
        <p data-note="no-fee" className="text-xs text-muted-foreground">
          {NO_FEE_NOTE}
        </p>
      )}
    </div>
  );
}
