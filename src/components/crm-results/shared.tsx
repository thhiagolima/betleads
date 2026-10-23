import { Info } from "lucide-react";

import { ratio } from "./format";

const decimal = (value: number, digits: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Small (i) with a short explanation of a metric. */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex align-middle text-muted-foreground hover:text-foreground"
            aria-label={text}
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-meta">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Variation against the previous period of the same length, green when it
 * moves the good way (`better`), red otherwise.
 */
export function Delta({
  current,
  previous,
  better = "high",
}: {
  current: number | null;
  previous: number | null | undefined;
  better?: "high" | "low";
}) {
  if (current == null || previous == null || previous === 0) return null;
  const change = (current - previous) / Math.abs(previous);
  if (!Number.isFinite(change)) return null;
  const good = better === "high" ? change >= 0 : change <= 0;
  return (
    <span
      className={`text-xs font-medium ${
        Math.abs(change) < 0.005 ? "text-muted-foreground" : good ? "text-success" : "text-danger"
      }`}
    >
      {change >= 0 ? "▲" : "▼"} {decimal(Math.abs(change) * 100, 0)}%
      <span className="sr-only"> em relação ao período anterior</span>
    </span>
  );
}

export function Kpi({
  label,
  value,
  detail,
  info,
  delta,
}: {
  label: string;
  value: string;
  detail?: string;
  info?: string;
  delta?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="flex items-center gap-1.5 text-label text-muted-foreground">
          {label}
          {info && <InfoTip text={info} />}
        </p>
        <div className="flex items-baseline gap-2">
          <p className="text-kpi tabular-nums">{value}</p>
          {delta}
        </div>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

/** Marks a card whose numbers do not follow the period filter (A-03). */
export function NotPeriodBadge() {
  return (
    <span className="ml-2 rounded-full border px-2 py-0.5 align-middle text-meta font-normal text-muted-foreground">
      não muda com o período
    </span>
  );
}

/** Return multiple coloured by payback; small samples are dimmed (B-06). */
export function RoiValue({ roi, smallSample }: { roi: number | null; smallSample?: boolean }) {
  if (roi == null || roi === 0) return <span className="text-muted-foreground">—</span>;
  if (smallSample)
    return (
      <span className="text-muted-foreground" title="Menos de 5 jogadores convertidos">
        {ratio(roi)}
        <span className="block text-meta">amostra pequena</span>
      </span>
    );
  return (
    <span className={`font-medium ${roi >= 1 ? "text-success" : "text-danger"}`}>{ratio(roi)}</span>
  );
}

export function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-6 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}
