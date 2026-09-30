import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  delta?: { value: string; positive?: boolean };
  hint?: string;
  accent?: "primary" | "success" | "warning" | "danger" | "ai";
  className?: string;
  children?: ReactNode;
}

const accentClasses: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  primary: "from-primary/15 to-primary/5 text-primary",
  success: "from-emerald-500/15 to-emerald-500/5 text-emerald-400",
  warning: "from-amber-500/15 to-amber-500/5 text-amber-400",
  danger: "from-rose-500/15 to-rose-500/5 text-rose-400",
  ai: "from-violet-500/15 to-violet-500/5 text-violet-400",
};

export function MetricCard({
  label,
  value,
  icon,
  delta,
  hint,
  accent = "primary",
  className,
  children,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        "card-premium group relative flex min-h-[132px] flex-col overflow-hidden rounded-xl p-4 sm:p-5",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <div className="mt-2.5 text-2xl font-semibold tracking-[-0.03em] text-foreground tabular-nums sm:text-[1.75rem]">
            {value}
          </div>
        </div>
        {icon && (
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-gradient-to-br transition-transform duration-200 group-hover:scale-105",
              accentClasses[accent],
            )}
          >
            {icon}
          </div>
        )}
      </div>
      {(delta || hint) && (
        <div className="mt-auto flex min-h-5 items-center gap-2 pt-3 text-xs text-muted-foreground">
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                delta.positive ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {delta.positive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {delta.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
