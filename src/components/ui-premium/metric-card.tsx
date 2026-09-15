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
    <div className={cn("card-premium rounded-xl p-4 sm:p-5 flex flex-col gap-2", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        {icon && (
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br",
              accentClasses[accent],
            )}
          >
            {icon}
          </div>
        )}
      </div>
      <div className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {(delta || hint) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                delta.positive ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {delta.positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {delta.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}