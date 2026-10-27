import type React from "react";
import { cn } from "@/lib/utils";

export type SegmentedFilterItem<T extends string> = {
  value: T;
  label: string;
  /** Shown after the label when known. */
  count?: number | null;
  /** Identity mark before the label (e.g. the level icon in its colour). */
  marker?: React.ReactNode;
};

/**
 * Compact single-choice filter with the PageTabs look (segmented control).
 * Scrolls sideways on phones instead of wrapping; 40px tall on touch, 36px on desktop.
 */
export function SegmentedFilter<T extends string>({
  label,
  value,
  onValueChange,
  items,
  className,
}: {
  /** Accessible name of the group ("Situação", "Nível"). */
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<SegmentedFilterItem<T>>;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:h-9",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.marker}
            {item.label}
            {item.count != null && (
              <span className="tabular-nums text-muted-foreground">
                {item.count.toLocaleString("pt-BR")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
