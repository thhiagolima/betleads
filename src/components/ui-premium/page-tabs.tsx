import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

export type PageTabItem<T extends string = string> = { value: T; label: string };

const segment =
  "h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Visible page tabs with the PeriodPicker look (segmented control). Controlled:
 * the page owns the value and keeps it in sync with the URL (hash).
 * Scrolls sideways on narrow screens instead of wrapping.
 */
export function PageTabs<T extends string>({
  value,
  onValueChange,
  items,
  label = "Seções da página",
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: ReadonlyArray<PageTabItem<T>>;
  label?: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const index = Math.max(
      0,
      items.findIndex((item) => item.value === value),
    );
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    onValueChange(items[next].value);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
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
            role="tab"
            id={`tab-${item.value}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              if (!active) onValueChange(item.value);
            }}
            className={cn(
              segment,
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
