import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  /** What the button does, for screen readers and the hover tooltip. Required. */
  label: string;
  icon: React.ReactNode;
}

/**
 * Icon-only button. The label is mandatory (no more unnamed buttons) and the hit
 * area is 36px on desktop and 44px on touch screens.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, className, variant = "ghost", ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant}
      size="icon"
      aria-label={label}
      title={label}
      className={cn("size-11 sm:size-9", className)}
      {...props}
    >
      {icon}
    </Button>
  ),
);
IconButton.displayName = "IconButton";
