import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GLOSSARY } from "@/help/glossary";
import { useHelp } from "./help-provider";

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

  if (!entry) return <>{children}</>;

  return (
    <>
      {children}{" "}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`O que é ${entry.term}?`}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onClick={() => setOpen((current) => !current)}
            className="inline-flex align-middle text-muted-foreground hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="max-w-xs text-meta"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
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
