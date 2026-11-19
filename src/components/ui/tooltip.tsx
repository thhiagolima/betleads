"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

/*
 * Radix's tooltip never opens by touch (it ignores touch pointer moves and
 * closes on click), so on a phone every explanation behind an (i) simply did
 * not exist. Here a tap on the trigger toggles it; a tap outside closes it.
 * Mouse and keyboard behave exactly as before.
 */
type TouchToggle = { toggleByTouch: () => void };
const TouchToggleContext = React.createContext<TouchToggle | null>(null);

function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen ?? false);
  const open = openProp ?? uncontrolled;
  // Radix asks to close right after the tap that opened it (its own onClick
  // handler); that one request is ignored.
  const ignoreCloseUntil = React.useRef(0);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next && Date.now() < ignoreCloseUntil.current) return;
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const touch = React.useMemo<TouchToggle>(
    () => ({
      toggleByTouch: () => {
        const next = !open;
        if (next) ignoreCloseUntil.current = Date.now() + 100;
        if (openProp === undefined) setUncontrolled(next);
        onOpenChange?.(next);
      },
    }),
    [open, openProp, onOpenChange],
  );

  return (
    <TouchToggleContext.Provider value={touch}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen} {...props} />
    </TouchToggleContext.Provider>
  );
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onPointerDown, onClick, ...props }, ref) => {
  const touch = React.useContext(TouchToggleContext);
  const lastPointer = React.useRef<string>("mouse");
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      onPointerDown={(event) => {
        lastPointer.current = event.pointerType;
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (lastPointer.current === "touch") touch?.toggleByTouch();
      }}
      {...props}
    />
  );
});
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        "z-50 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-tooltip-content-transform-origin)",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
