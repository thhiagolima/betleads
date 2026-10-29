// "Como calculamos" (task 5): a small (i) next to a number's label that
// shows FINANCE_TERMS[term].how on hover and on tap. Controlled `open`
// state (rather than Radix's own hover/focus handling) so a tap toggles it
// too, which Radix's default trigger doesn't reliably do on touch.
//
// Relies on a TooltipProvider higher up the tree (one per page/section, not
// one per tooltip) — see the root of KpiCards and GroupScoreboard.
import { useState } from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";

export function TermTooltip({ term }: { term: TermKey }) {
  const [open, setOpen] = useState(false);
  const { how } = FINANCE_TERMS[term];

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="ml-1 inline-flex align-middle text-muted-foreground outline-none hover:text-foreground"
          aria-label="Como calculamos"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{how}</TooltipContent>
    </Tooltip>
  );
}
