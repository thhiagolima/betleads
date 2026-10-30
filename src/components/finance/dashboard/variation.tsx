// The variation vs the compared window, shared by the result band, the KPI
// blocks and the sends block: money and counts vary in % (▲/▼), ratios in
// percentage points. Cost-shaped numbers (anúncios, saques, envios…) pass
// `invert` so a rise shows red. Nothing renders when there is nothing to
// compare (visibleChange): no "n.a." under the values.
import { formatPct, formatPp } from "@/components/finance/format";
import { cn } from "@/lib/utils";

import { visibleChange } from "./display";

export function Variation({
  current,
  previous,
  hasPrevious = true,
  points = false,
  invert = false,
  className,
}: {
  current: number | null;
  previous: number | null;
  /** The compared period has data (periodHasData). */
  hasPrevious?: boolean;
  /** Ratio: vary in percentage points instead of %. */
  points?: boolean;
  /** An increase is bad. */
  invert?: boolean;
  className?: string;
}) {
  const change = visibleChange(current, previous, { hasPrevious, points });
  if (change === null) return null;
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span
      className={cn(
        "whitespace-nowrap text-xs font-medium",
        good ? "text-emerald-400" : "text-rose-400",
        className,
      )}
    >
      {points ? formatPp(change) : `${change >= 0 ? "▲" : "▼"} ${formatPct(Math.abs(change))}`}
    </span>
  );
}

/** True when <Variation> with these props would render something. */
export function hasVariation(
  current: number | null,
  previous: number | null,
  hasPrevious: boolean,
  points = false,
): boolean {
  return visibleChange(current, previous, { hasPrevious, points }) !== null;
}
