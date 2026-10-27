import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

export type FunnelStage<T extends string = string> = {
  value: T;
  label: string;
  /** Whole-source count for this stage (server total, never the loaded rows). */
  count: number | null;
  tone?: "neutral" | "success" | "warning";
};

const countTone = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
} as const;

/**
 * The report's funnel: every stage with its number, in one segmented control
 * that scrolls sideways on narrow screens. Picking a stage filters the list.
 */
export function FunnelFilter<T extends string>({
  stages,
  value,
  onValueChange,
  label = "Etapas do funil",
  className,
}: {
  stages: ReadonlyArray<FunnelStage<T>>;
  value: T;
  onValueChange: (value: T) => void;
  label?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || stages.length === 0) return;
    event.preventDefault();
    const index = Math.max(
      0,
      stages.findIndex((stage) => stage.value === value),
    );
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % stages.length;
    if (event.key === "ArrowLeft") next = (index - 1 + stages.length) % stages.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = stages.length - 1;
    onValueChange(stages[next].value);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[next]?.focus();
    buttons?.[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]",
        className,
      )}
    >
      {stages.map((stage) => {
        const active = stage.value === value;
        return (
          <button
            key={stage.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              if (!active) onValueChange(stage.value);
            }}
            className={cn(
              "flex min-h-11 shrink-0 flex-col items-start justify-center whitespace-nowrap rounded-lg px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
              active ? "bg-secondary" : "hover:bg-foreground/[0.04]",
            )}
          >
            <span className={cn("text-meta", active ? "text-foreground" : "text-muted-foreground")}>
              {stage.label}
            </span>
            <span
              className={cn(
                "text-body font-semibold tabular-nums",
                countTone[stage.tone ?? "neutral"],
              )}
            >
              {stage.count === null ? "—" : stage.count.toLocaleString("pt-BR")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
