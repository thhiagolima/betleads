// Layout A, approved mockup (spec §6):
// .superpowers/brainstorm/5093-1792850661/content/painel-grupo.html — one row
// per house, Depósitos/FTDs/Custo-FTD/Net/Resultado/ROI always visible,
// Cadastros/GGR behind "mais colunas". Every cell shows the value and its
// variation vs the compared window (fix round 1, item 1); a goal cell also
// gets the green/yellow/red/gray class from evaluateGoal (spec §7) plus a
// "meta X" caption.
import { useMemo, useState } from "react";

import {
  formatBRL,
  formatInt,
  formatPct,
  formatPp,
  formatRatio,
  GGR_COLUMN_LABEL,
} from "@/components/finance/format";
import { FINANCE_TERMS, type TermKey } from "@/components/finance/definitions";
import { TermTooltip } from "@/components/finance/term-tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pctChange, ppChange } from "@/lib/finance/calc";
import type { GoalEvaluation, GoalMetric, GoalStatus, PeriodSummary } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

export type ScoreboardRow = {
  id: string;
  nome: string;
  current: PeriodSummary;
  previous: PeriodSummary;
  goals: GoalEvaluation[];
};

export type ScoreboardColumnKey =
  "registrations" | "depositAmount" | "ftds" | "costPerFtd" | "net" | "cashResult" | "roi" | "ggr";

type ColumnDef = {
  key: ScoreboardColumnKey;
  label: string;
  /** The FINANCE_TERMS entry this column maps to, if any; renders a TermTooltip next to the header. */
  term?: TermKey;
  goalMetric?: GoalMetric;
  format: "money" | "int" | "ratio";
  pick: (summary: PeriodSummary) => number | null;
  /** True when an increase is bad (cost-shaped metric): variation color is inverted. */
  invert?: boolean;
};

const CORE_COLUMNS: ColumnDef[] = [
  {
    key: "depositAmount",
    label: "Depósitos",
    goalMetric: "deposits",
    format: "money",
    pick: (s) => s.depositAmount,
  },
  { key: "ftds", label: "FTDs", goalMetric: "ftds", format: "int", pick: (s) => s.ftds },
  {
    key: "costPerFtd",
    label: "Custo/FTD",
    goalMetric: "cost_per_ftd",
    format: "money",
    pick: (s) => s.costPerFtd,
    invert: true,
  },
  {
    key: "net",
    label: FINANCE_TERMS.net.label,
    term: "net",
    goalMetric: "net",
    format: "money",
    pick: (s) => s.net,
  },
  {
    key: "cashResult",
    label: FINANCE_TERMS.cashResult.label,
    term: "cashResult",
    goalMetric: "cash_result",
    format: "money",
    pick: (s) => s.cashResult,
  },
  {
    key: "roi",
    label: FINANCE_TERMS.roi.label,
    term: "roi",
    goalMetric: "roi",
    format: "ratio",
    pick: (s) => s.roi,
  },
];

const EXTRA_COLUMNS: ColumnDef[] = [
  {
    key: "registrations",
    label: "Cadastros",
    goalMetric: "registrations",
    format: "int",
    pick: (s) => s.registrations,
  },
  { key: "ggr", label: GGR_COLUMN_LABEL, term: "ggr", format: "money", pick: (s) => s.ggr },
];

const ALL_COLUMNS = [...CORE_COLUMNS, ...EXTRA_COLUMNS];

export const GOAL_STATUS_CLASS: Record<GoalStatus, string> = {
  green: "bg-emerald-500/15 text-emerald-300",
  yellow: "bg-amber-500/15 text-amber-300",
  red: "bg-rose-500/15 text-rose-300",
  gray: "bg-muted/40 text-muted-foreground",
};

function formatValue(format: ColumnDef["format"], value: number | null) {
  if (format === "money") return formatBRL(value);
  if (format === "ratio") return formatRatio(value);
  return formatInt(value);
}

function goalFor(goals: GoalEvaluation[], metric: GoalMetric | undefined) {
  if (!metric) return null;
  return goals.find((goal) => goal.metric === metric) ?? null;
}

/** Pure sort, exported for the scoreboard tests and used by the header-click
 * handler below; nulls always sort last regardless of direction. */
export function sortScoreboardRows(
  rows: ScoreboardRow[],
  column: ScoreboardColumnKey,
  direction: "asc" | "desc",
): ScoreboardRow[] {
  const def = ALL_COLUMNS.find((c) => c.key === column);
  if (!def) return rows;
  return [...rows].sort((a, b) => {
    const av = def.pick(a.current);
    const bv = def.pick(b.current);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return direction === "asc" ? av - bv : bv - av;
  });
}

/** A ratio column (ROI) varies in percentage points, never as a % of a ratio. */
function VariationLabel({
  column,
  current,
  previous,
}: {
  column: ColumnDef;
  current: number | null;
  previous: number | null;
}) {
  const ratio = column.format === "ratio";
  const change = ratio ? ppChange(current, previous) : pctChange(current, previous);
  if (change === null) return null;
  const good = column.invert ? change <= 0 : change >= 0;
  return (
    <span className={cn("block text-[10px]", good ? "text-emerald-400" : "text-rose-400")}>
      {ratio ? formatPp(change) : `${change >= 0 ? "▲" : "▼"} ${formatPct(Math.abs(change))}`}
    </span>
  );
}

export function GroupScoreboard({
  rows,
  onRowClick,
  defaultMoreColumns = false,
}: {
  rows: ScoreboardRow[];
  onRowClick?: (tenantId: string) => void;
  /** Start with "mais colunas" open (Cadastros, GGR). */
  defaultMoreColumns?: boolean;
}) {
  const [moreColumns, setMoreColumns] = useState(defaultMoreColumns);
  const [sort, setSort] = useState<{
    column: ScoreboardColumnKey;
    direction: "asc" | "desc";
  } | null>(null);

  const columns = moreColumns ? ALL_COLUMNS : CORE_COLUMNS;
  const sortedRows = useMemo(
    () => (sort ? sortScoreboardRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );

  const toggleSort = (column: ScoreboardColumnKey) => {
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === "desc" ? "asc" : "desc" }
        : { column, direction: "desc" },
    );
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-2">
        <div className="overflow-x-auto rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 text-left text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2">Casa</th>
                {columns.map((column) => (
                  <th key={column.key} className="px-3 py-2 text-right">
                    {/* The sort trigger wraps only the (possibly truncated)
                      label text; a TermTooltip, when present, is a sibling
                      so this never nests a <button> inside a <button>. */}
                    <span className="inline-flex items-center justify-end gap-1">
                      <button
                        type="button"
                        className="max-w-[8rem] truncate rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        title={column.label}
                        onClick={() => toggleSort(column.key)}
                      >
                        {column.label}
                      </button>
                      {column.term && <TermTooltip term={column.term} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/20 last:border-0 hover:bg-foreground/[0.03]"
                >
                  <td className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      className="rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onRowClick?.(row.id)}
                    >
                      {row.nome}
                    </button>
                  </td>
                  {columns.map((column) => {
                    const goal = goalFor(row.goals, column.goalMetric);
                    const value = column.pick(row.current);
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "px-3 py-2 text-right",
                          goal && GOAL_STATUS_CLASS[goal.status],
                        )}
                      >
                        <span>{formatValue(column.format, value)}</span>
                        <VariationLabel
                          column={column}
                          current={value}
                          previous={column.pick(row.previous)}
                        />
                        {goal && (
                          <span className="block text-[10px] opacity-60">
                            meta {formatValue(column.format, goal.target)}
                          </span>
                        )}
                        {!goal && column.goalMetric && (
                          <span className="block text-[10px] opacity-60">sem meta</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!sortedRows.length && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-3 py-8 text-center text-sm text-muted-foreground"
                  >
                    Nenhuma casa neste grupo ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setMoreColumns((current) => !current)}
        >
          {moreColumns ? "menos colunas" : "mais colunas"}
        </button>
      </div>
    </TooltipProvider>
  );
}
