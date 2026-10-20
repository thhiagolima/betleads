import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";

import type { Trend } from "@/lib/home-dashboard";
import { cn } from "@/lib/utils";

const trendToneClass: Record<Trend["tone"], string> = {
  positive: "text-emerald-400",
  negative: "text-rose-400",
  neutral: "text-muted-foreground",
};

export function TrendText({ trend, className }: { trend: Trend | null; className?: string }) {
  if (!trend) return null;
  return (
    <span className={cn("font-semibold tabular-nums", trendToneClass[trend.tone], className)}>
      {trend.label}
    </span>
  );
}

export function HomeCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card/80", className)}>
      {children}
    </section>
  );
}

export function KpiCard({
  title,
  value,
  trend,
  detail,
  sparkline,
  className,
}: {
  title: string;
  value: string;
  trend?: Trend | null;
  detail?: string;
  sparkline?: Array<{ value: number }>;
  className?: string;
}) {
  return (
    <HomeCard className={cn("flex flex-col p-4 sm:p-5", className)}>
      <h3 className="text-[12.5px] font-normal text-muted-foreground">{title}</h3>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <p className="min-w-0 truncate text-2xl font-semibold tracking-[-0.03em] tabular-nums sm:text-[28px]">
          {value}
        </p>
        {sparkline && sparkline.length > 1 && (
          <div className="h-9 w-24 shrink-0" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2.2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {(trend || detail) && (
        <p className="mt-2 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <TrendText trend={trend ?? null} />
          {detail && <span>{detail}</span>}
        </p>
      )}
    </HomeCard>
  );
}

export function MetricRow({
  label,
  value,
  valueClassName,
  to,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  to?: "/jornadas" | "/resultados" | "/eventos";
}) {
  const content = (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <strong className={cn("font-semibold tabular-nums", valueClassName)}>{value}</strong>
        {to && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
      </span>
    </>
  );
  const classes =
    "flex items-center justify-between gap-3 border-b border-border/70 py-2.5 text-[13.5px] last:border-b-0";
  return to ? (
    <Link to={to} className={cn(classes, "-mx-2 rounded-md px-2 hover:bg-foreground/[0.04]")}>
      {content}
    </Link>
  ) : (
    <div className={classes}>{content}</div>
  );
}
