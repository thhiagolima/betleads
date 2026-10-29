// Lançamentos as a day list (docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md
// §3.4), replacing the 13-column grid: one row per day with its status chip,
// Net, Envios and Lucro líquido. A row opens the day modal (day-modal.tsx).
// No table: on a phone each row wraps into two lines, so nothing scrolls
// sideways.
import type { ReactNode } from "react";

import { FINANCE_TERMS } from "@/components/finance/definitions";
import { dayLabel, dayResult, dayStatus, type DayStatus } from "@/components/finance/day-entry";
import { SendCostAmount } from "@/components/finance/dashboard/sends-block";
import { formatBRL } from "@/components/finance/format";
import type { FinanceDay, SendUsage } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

const MISSING_CLASS = "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";

const STATUS_CLASS: Record<DayStatus, string> = {
  completo: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  estimado: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "falta anúncios": MISSING_CLASS,
  "falta GGR": MISSING_CLASS,
  "falta anúncios e GGR": MISSING_CLASS,
  "falta GGR do mês": MISSING_CLASS,
  "falta anúncios e GGR do mês": MISSING_CLASS,
};

export function DayStatusChip({ status }: { status: DayStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px]",
        STATUS_CLASS[status],
      )}
    >
      {status}
    </span>
  );
}

type ListCost = { costDate: string; valor: number; categoria: string };

const ROW_GRID = "sm:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]";

export function DayList({
  days,
  sendsByDay,
  otherCosts,
  onOpen,
  focusDate,
  usingMonthlyGgr = false,
}: {
  days: FinanceDay[];
  sendsByDay: Record<string, SendUsage[]>;
  otherCosts: ListCost[];
  onOpen: (date: string) => void;
  /** Ringed row (the day "Lançar agora" pointed at). */
  focusDate?: string;
  /** The month has a "GGR do mês" total (a day without GGR lacks the month's). */
  usingMonthlyGgr?: boolean;
}) {
  if (days.length === 0) {
    return (
      <p className="rounded-lg border border-border/40 py-8 text-center text-sm text-muted-foreground">
        Nenhum dia neste mês ainda.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/40">
      <div
        className={cn(
          "hidden gap-3 border-b border-border/40 px-3 py-2 text-xs text-muted-foreground sm:grid",
          ROW_GRID,
        )}
      >
        <span>Dia</span>
        <span className="truncate text-right">{FINANCE_TERMS.net.label}</span>
        <span className="truncate text-right">{FINANCE_TERMS.sends.label}</span>
        <span className="truncate text-right">{FINANCE_TERMS.cashResult.label}</span>
      </div>
      <ul className="divide-y divide-border/40">
        {days.map((day) => {
          const costs = otherCosts.filter((cost) => cost.costDate === day.date);
          const { summary, sendCost, sendCostIncomplete } = dayResult(
            day,
            sendsByDay[day.date],
            costs,
          );
          return (
            <li key={day.date}>
              <button
                type="button"
                data-date={day.date}
                onClick={() => onOpen(day.date)}
                className={cn(
                  "grid w-full grid-cols-3 gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                  ROW_GRID,
                  day.date === focusDate && "bg-primary/10 ring-2 ring-inset ring-primary",
                )}
              >
                <span className="col-span-3 flex min-w-0 items-center gap-2 sm:col-span-1">
                  <span className="font-medium tabular-nums">{dayLabel(day.date)}</span>
                  <DayStatusChip status={dayStatus(day, usingMonthlyGgr)} />
                </span>
                <DayFigure label={FINANCE_TERMS.net.label} value={summary.net} />
                <DayFigure
                  label={FINANCE_TERMS.sends.label}
                  value={sendCost}
                  display={<SendCostAmount amount={sendCost} incomplete={sendCostIncomplete} />}
                />
                <DayFigure
                  label={FINANCE_TERMS.cashResult.label}
                  value={summary.cashResult}
                  strong
                  negative={summary.cashResult < 0}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A number of the row; its label shows only on a phone (the header names it above). */
function DayFigure({
  label,
  value,
  strong = false,
  negative = false,
  display,
}: {
  label: string;
  value: number;
  strong?: boolean;
  negative?: boolean;
  /** Replaces the plain formatted value (e.g. a partial Envios). */
  display?: ReactNode;
}) {
  return (
    <span className="min-w-0 sm:text-right">
      <span className="block truncate text-[11px] text-muted-foreground sm:hidden">{label}</span>
      <span
        className={cn(
          "block truncate tabular-nums",
          strong && "font-medium",
          negative && "text-destructive",
        )}
      >
        {display ?? formatBRL(value)}
      </span>
    </span>
  );
}
