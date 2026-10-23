import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface DataCardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** @deprecated Decorative icons are gone in the redesign; ignored. */
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** Card with a section header (15px title, 12.5px description, actions on the right). */
export function DataCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: DataCardProps) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card/80", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-5 sm:pt-5">
          <div className="min-w-0">
            {title && <h2 className="text-section">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
