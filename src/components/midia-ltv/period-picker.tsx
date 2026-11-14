import { Calendar } from "lucide-react";
import { Input } from "@/components/ui/input";
import { tourAnchor } from "@/help/anchor";
import { brtToday, type PeriodPreset } from "@/lib/marketing-overview";
import { cn } from "@/lib/utils";

const periodLabels: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "7 dias",
  "30d": "30 dias",
  this_month: "Este mês",
  last_month: "Mês passado",
};

/** Período das abas Mídia e Origem: atalhos + datas. `anchored` liga as âncoras do tour da Mídia. */
export function MediaPeriodPicker({
  range,
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
  anchored = false,
}: {
  range: { from: string; to: string };
  period: PeriodPreset;
  customRange: { from: string; to: string } | null;
  onPeriodChange: (value: PeriodPreset) => void;
  onCustomRangeChange: (value: { from: string; to: string }) => void;
  anchored?: boolean;
}) {
  return (
    <>
      {/* Same segmented look as the Início period picker. */}
      <div
        role="group"
        aria-label="Período"
        className="flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]"
      >
        {(Object.keys(periodLabels) as PeriodPreset[]).map((key, index) => (
          <button
            key={key}
            type="button"
            aria-pressed={!customRange && period === key}
            onClick={() => onPeriodChange(key)}
            className={cn(
              "h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              !customRange && period === key
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            {...(anchored && index === 0 ? tourAnchor("midia.periodo.presets") : {})}
          >
            {periodLabels[key]}
          </button>
        ))}
      </div>
      <div className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-1 sm:w-auto">
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label="Data inicial"
          type="date"
          className="h-8 w-full min-w-0 border-0 bg-transparent p-0 sm:w-36"
          value={customRange?.from ?? range.from}
          max={customRange?.to ?? range.to}
          onChange={(event) =>
            onCustomRangeChange({ from: event.target.value, to: customRange?.to ?? range.to })
          }
          {...(anchored ? tourAnchor("midia.periodo.data-inicial") : {})}
        />
        <span className="text-xs text-muted-foreground">até</span>
        <Input
          aria-label="Data final"
          type="date"
          className="h-8 w-full min-w-0 border-0 bg-transparent p-0 sm:w-36"
          value={customRange?.to ?? range.to}
          min={customRange?.from ?? range.from}
          max={brtToday()}
          onChange={(event) =>
            onCustomRangeChange({ from: customRange?.from ?? range.from, to: event.target.value })
          }
        />
      </div>
    </>
  );
}
