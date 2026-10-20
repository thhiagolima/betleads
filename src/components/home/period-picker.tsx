import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";

import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PERIOD_PRESETS, periodRange, type PeriodPreset } from "@/lib/home-dashboard";
import { cn } from "@/lib/utils";

const segment =
  "h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

export function PeriodPicker({
  preset,
  range,
  onChange,
}: {
  preset: PeriodPreset;
  range: DateRange | undefined;
  onChange: (preset: PeriodPreset, range: DateRange | undefined) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      role="group"
      aria-label="Período"
      className="flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]"
    >
      {PERIOD_PRESETS.map((option) => {
        const active = preset === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value, periodRange(option.value))}
            className={cn(
              segment,
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-pressed={preset === "custom"}
            className={cn(
              segment,
              "flex items-center gap-1.5",
              preset === "custom"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CalendarIcon className="size-4" aria-hidden="true" />
            Datas
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-0">
          <Calendar
            mode="range"
            selected={range}
            onSelect={(next) => {
              if (!next?.from) return;
              onChange("custom", next);
              // Close once a real span is picked; a single day keeps it open for the second click.
              if (next.to && next.to.getTime() !== next.from.getTime()) setOpen(false);
            }}
            numberOfMonths={2}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
