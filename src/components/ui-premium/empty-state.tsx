import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Quiet empty state: small neutral icon, 15px title, 13.5px description. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}
    >
      {icon && (
        <div
          className="mb-3 flex size-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground [&_svg]:size-5"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3 className="text-section">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-body text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
