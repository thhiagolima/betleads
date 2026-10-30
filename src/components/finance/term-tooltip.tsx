// "Como calculamos" (task 5): a small (i) next to a number's label that
// shows FINANCE_TERMS[term].how on hover and on tap. Controlled `open`
// state (rather than Radix's own hover/focus handling) so a tap toggles it
// too, which Radix's default trigger doesn't reliably do on touch.
//
// Relies on a TooltipProvider higher up the tree (one per page/section, not
// one per tooltip) — see the root of the finance dashboard and GroupScoreboard.
import { useRef, useState } from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";

/**
 * Whether to follow Radix's request to open/close the tooltip. An open that
 * comes from focus alone, without the keyboard (:focus-visible) or the
 * pointer over the (i) — e.g. a dialog focusing its first button when it
 * opens — is ignored.
 */
export function acceptTooltipOpen(
  next: boolean,
  state: { focused: boolean; focusVisible: boolean; hovered: boolean },
): boolean {
  if (!next) return true;
  return state.hovered || !state.focused || state.focusVisible;
}

export function TermTooltip({ term }: { term: TermKey }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const { how } = FINANCE_TERMS[term];

  const onOpenChange = (next: boolean) => {
    const trigger = triggerRef.current;
    const focused = !!trigger && trigger === document.activeElement;
    let focusVisible = true;
    try {
      focusVisible = !!trigger && trigger.matches(":focus-visible");
    } catch {
      // Old engines without :focus-visible: keep Radix's behavior.
    }
    if (acceptTooltipOpen(next, { focused, focusVisible, hovered: hovered.current })) {
      setOpen(next);
    }
  };

  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onPointerEnter={() => {
            hovered.current = true;
          }}
          onPointerLeave={() => {
            hovered.current = false;
          }}
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
