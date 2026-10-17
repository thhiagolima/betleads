import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEMO_ACTION_BLOCKED_TEXT } from "@/lib/demo-tenant";

/**
 * Wraps a (now-disabled) integration action with a tooltip explaining why,
 * for demo tenants. Renders children unchanged when `active` is false, so
 * call sites just add `disabled={isDemo}` to the control and wrap it here.
 *
 * The trigger is a focusable/hoverable wrapper span, not the control itself:
 * a `disabled` button/input swallows pointer and focus events, so Radix's
 * tooltip would never open if it triggered off the disabled element.
 */
export function DemoDisabledTooltip({
  active,
  text = DEMO_ACTION_BLOCKED_TEXT,
  children,
}: {
  active: boolean;
  text?: string;
  children: ReactNode;
}) {
  if (!active) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
