// The variation vs the compared window, shared by the result band, the KPI
// blocks and the sends block: money and counts vary in % (▲/▼), ratios in
// percentage points. Cost-shaped numbers (anúncios, saques, envios…) pass
// `invert` so a rise shows red.
import { formatPct, formatPp } from "@/components/finance/format";
import { pctChange, ppChange } from "@/lib/finance/calc";
import { cn } from "@/lib/utils";

export function Variation({
  current,
  previous,
  points = false,
  invert = false,
}: {
  current: number | null;
  previous: number | null;
  /** Ratio: vary in percentage points instead of %. */
  points?: boolean;
  /** An increase is bad. */
  invert?: boolean;
}) {
  const change = points ? ppChange(current, previous) : pctChange(current, previous);
  if (change === null) return <span className="text-xs text-muted-foreground">n.a.</span>;
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span className={cn("whitespace-nowrap text-xs", good ? "text-emerald-400" : "text-rose-400")}>
      {points ? formatPp(change) : `${change >= 0 ? "▲" : "▼"} ${formatPct(Math.abs(change))}`}
    </span>
  );
}
