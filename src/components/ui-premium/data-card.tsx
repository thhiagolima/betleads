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
    <div className={cn("card-premium rounded-xl", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="flex items-start gap-3 min-w-0">
            {icon && (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
              )}
              {description && (
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn("p-5", title && "pt-2", bodyClassName)}>{children}</div>
    </div>
  );
}