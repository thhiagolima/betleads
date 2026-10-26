import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** @deprecated Decorative icons are gone in the redesign; ignored. */
  icon?: ReactNode;
  /**
   * Change vs. the previous period. `positive` says whether the change is GOOD
   * (not whether the number went up): it only picks the colour.
   */
  delta?: { value: string; positive?: boolean };
  hint?: string;
  /** @deprecated Kept for call sites; the card no longer has an accent colour. */
  accent?: "primary" | "success" | "warning" | "danger" | "ai";
  className?: string;
  children?: ReactNode;
}

/** Same look as the Início KPI card: 12.5px label, 28px number, 12px detail. */
export function MetricCard({ label, value, delta, hint, className, children }: MetricCardProps) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-2xl border border-border bg-card/80 p-4 sm:p-5",
        className,
      )}
    >
      <h3 className="truncate text-label font-normal text-muted-foreground">{label}</h3>
      <div className="mt-1.5 text-2xl font-semibold tracking-[-0.03em] tabular-nums sm:text-kpi">
        {value}
      </div>
      {(delta || hint) && (
        <p className="mt-2 flex flex-wrap gap-x-1.5 text-meta text-muted-foreground">
          {delta && (
            <span className={cn("font-semibold", delta.positive ? "text-success" : "text-danger")}>
              {delta.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </p>
      )}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
