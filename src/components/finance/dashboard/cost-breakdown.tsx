// "Para onde foi o dinheiro" (spec §5.5): one row per CostLine, in the order
// the server sends (largest first), with a bar proportional to the largest
// line, the amount and the variation vs the compared window. Every line is a
// cost, so a rise is red. Amounts come rounded from costBreakdown(), which
// sets `auto` only on the Betleads line (the "automático" tag, spec §7).
import { formatBRL, formatPct } from "@/components/finance/format";
import { pctChange } from "@/lib/finance/calc";
import type { CostLine } from "@/lib/finance/types";

function Variation({ line }: { line: CostLine }) {
  const change = pctChange(line.amount, line.previous);
  if (change === null) return <span className="text-muted-foreground">n.a.</span>;
  return (
    <span className={change <= 0 ? "text-emerald-400" : "text-rose-400"}>
      {change >= 0 ? "▲" : "▼"} {formatPct(Math.abs(change))}
    </span>
  );
}

export function CostBreakdown({ costs }: { costs: CostLine[] }) {
  if (!costs.length) {
    return <p className="py-4 text-sm text-muted-foreground">Sem custos no período.</p>;
  }
  const max = Math.max(...costs.map((line) => Math.abs(line.amount)));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[22rem] text-sm">
        <tbody>
          {costs.map((line) => {
            const width = max > 0 ? Math.round((Math.abs(line.amount) / max) * 100) : 0;
            return (
              <tr
                key={line.key}
                data-cost={line.key}
                className="border-b border-border/20 last:border-0"
              >
                <td className="py-2 pr-3">
                  {line.label}
                  {line.auto && (
                    <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                      automático
                    </span>
                  )}
                </td>
                <td className="w-2/5 py-2 pr-3">
                  <div className="h-2 rounded-full bg-muted/40">
                    <div className="h-2 rounded-full bg-primary" style={{ width: `${width}%` }} />
                  </div>
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-right">{formatBRL(line.amount)}</td>
                <td className="whitespace-nowrap py-2 text-right text-xs">
                  <Variation line={line} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
