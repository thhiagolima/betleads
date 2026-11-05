import { Info } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GLOSSARY } from "@/help/glossary";
import { useHelp } from "./help-provider";
import { nextTermOpen } from "./term-open";

/** Gap (ms) before a hover-leave actually closes the popover, cancelled if
 * the pointer re-enters the trigger or the content first — avoids flicker
 * while moving the mouse across the small gap between the two. */
const HOVER_CLOSE_DELAY_MS = 150;

/**
 * Wraps a term used in the UI with an "i" that explains it (brief, Task 5).
 * Opens on hover (desktop) or tap (mobile) — a `Popover`, not the
 * `Tooltip`-based `InfoTip` (shared.tsx), because Radix Tooltip doesn't open
 * on tap. With an unknown `id`, renders only `children`: the coverage test
 * (-coverage.test.ts) is what's expected to fail in that case, not this
 * component.
 */
export function Term({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { openPanel } = useHelp();
  const entry = GLOSSARY.find((candidate) => candidate.id === id);
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => clearCloseTimer, []);

  const handleHoverEnter = () => {
    clearCloseTimer();
    setOpen((current) => nextTermOpen(current, { type: "hover-enter" }));
  };
  // Debounced: moving the mouse from the trigger to the content crosses a
  // small gap, and without the delay that gap's hover-leave would close the
  // popover before hover-enter on the content re-opens it.
  const scheduleHoverLeave = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      setOpen((current) => nextTermOpen(current, { type: "hover-leave" }));
    }, HOVER_CLOSE_DELAY_MS);
  };
  const handlePointerDown = (event: PointerEvent) => {
    clearCloseTimer();
    const pointerType = event.pointerType === "touch" || event.pointerType === "pen"
      ? event.pointerType
      : "mouse";
    setOpen((current) => nextTermOpen(current, { type: "pointerdown", pointerType }));
  };

  if (!entry) return <>{children}</>;

  return (
    <>
      {children}{" "}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`O que é ${entry.term}?`}
            onMouseEnter={handleHoverEnter}
            onMouseLeave={scheduleHoverLeave}
            onPointerDown={handlePointerDown}
            className="inline-flex align-middle text-muted-foreground hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="max-w-xs text-meta"
          onMouseEnter={handleHoverEnter}
          onMouseLeave={scheduleHoverLeave}
        >
          <p>{entry.short}</p>
          {entry.long ? (
            <button
              type="button"
              className="mt-2 block text-xs underline hover:no-underline"
              onClick={() => {
                setOpen(false);
                openPanel(`glossary:${id}`);
              }}
            >
              Ver no glossário
            </button>
          ) : null}
        </PopoverContent>
      </Popover>
    </>
  );
}
