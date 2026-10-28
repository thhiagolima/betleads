// "Lucro por casa" (spec §6): one row per house of a group or of "Todas as
// casas", with Lucro, ROI, Anúncios and the profit variation. Sortable by
// header (desc first, asc on the second click, nulls always last); a row
// click opens the house's painel.
import { useMemo, useState } from "react";

import { formatBRL, formatPct, formatRatio } from "@/components/finance/format";
import { pctChange } from "@/lib/finance/calc";
import type { PeriodSummary } from "@/lib/finance/types";
import { cn } from "@/lib/utils";

export type TenantProfitRow = {
  id: string;
  nome: string;
  current: PeriodSummary;
  previous: PeriodSummary;
};

export type TenantProfitColumn = "nome" | "cashResult" | "roi" | "adSpend" | "profitChange";

const COLUMNS: { key: TenantProfitColumn; label: string }[] = [
  { key: "nome", label: "Casa" },
  { key: "cashResult", label: "Lucro" },
  { key: "roi", label: "ROI" },
  { key: "adSpend", label: "Anúncios" },
  { key: "profitChange", label: "Δ lucro" },
];

function numericValue(row: TenantProfitRow, column: Exclude<TenantProfitColumn, "nome">) {
  if (column === "profitChange") return pctChange(row.current.cashResult, row.previous.cashResult);
  return row.current[column];
}

/** Pure sort, exported for the tests and used by the header-click handler. */
export function sortTenantProfitRows<T extends TenantProfitRow>(
  rows: T[],
  column: TenantProfitColumn,
  direction: "asc" | "desc",
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  if (column === "nome") {
    return [...rows].sort((a, b) => sign * a.nome.localeCompare(b.nome, "pt-BR"));
  }
  return [...rows].sort((a, b) => {
    const av = numericValue(a, column);
    const bv = numericValue(b, column);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sign * (av - bv);
  });
}

function ProfitChange({ row }: { row: TenantProfitRow }) {
  const change = numericValue(row, "profitChange");
  if (change === null) return <span className="text-muted-foreground">n.a.</span>;
  return (
    <span className={change >= 0 ? "text-emerald-400" : "text-rose-400"}>
      {change >= 0 ? "▲" : "▼"} {formatPct(Math.abs(change))}
    </span>
  );
}

export function TenantProfitTable({
  rows,
  onOpenTenant,
}: {
  rows: TenantProfitRow[];
  onOpenTenant?: (tenantId: string) => void;
}) {
  const [sort, setSort] = useState<{
    column: TenantProfitColumn;
    direction: "asc" | "desc";
  } | null>(null);
  const sortedRows = useMemo(
    () => (sort ? sortTenantProfitRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );

  const toggleSort = (column: TenantProfitColumn) => {
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === "desc" ? "asc" : "desc" }
        : { column, direction: "desc" },
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border/40">
      <table className="w-full min-w-[32rem] text-sm">
        <thead>
          <tr className="border-b border-border/40 text-xs uppercase text-muted-foreground">
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={cn("px-3 py-2", column.key === "nome" ? "text-left" : "text-right")}
              >
                <button
                  type="button"
                  className="rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleSort(column.key)}
                >
                  {column.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                "border-b border-border/20 last:border-0",
                onOpenTenant && "cursor-pointer hover:bg-foreground/[0.03]",
              )}
              onClick={() => onOpenTenant?.(row.id)}
            >
              <td className="px-3 py-2 font-medium">
                <button
                  type="button"
                  className="rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenTenant?.(row.id);
                  }}
                >
                  {row.nome}
                </button>
              </td>
              <td
                className={cn(
                  "whitespace-nowrap px-3 py-2 text-right",
                  row.current.cashResult < 0 && "text-rose-400",
                )}
              >
                {formatBRL(row.current.cashResult)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {formatRatio(row.current.roi)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                {formatBRL(row.current.adSpend)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                <ProfitChange row={row} />
              </td>
            </tr>
          ))}
          {!sortedRows.length && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                Nenhuma casa neste recorte.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
