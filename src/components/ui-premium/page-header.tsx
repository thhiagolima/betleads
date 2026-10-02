import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  iconClassName?: string;
  className?: string;
}

export function PageHeader({ title, subtitle, icon, actions, iconClassName, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-center justify-between gap-4", className)}>
      <div className="flex items-center gap-3 min-w-0">
        {icon && (
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent glow-blue",
            iconClassName,
          )}>
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      )}
    </header>
  );
}
