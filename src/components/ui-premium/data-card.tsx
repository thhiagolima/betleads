import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DataCardProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function DataCard({
  title,
  description,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: DataCardProps) {
  return (
    <section className={cn("card-premium relative overflow-hidden rounded-xl", className)}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-border/50 px-5 py-4">
          <div className="flex items-start gap-3 min-w-0">
            {icon && (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                  {title}
                </h3>
              )}
              {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
