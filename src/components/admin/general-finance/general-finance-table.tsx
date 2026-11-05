// Task 4 — "Financeiro geral" tab (super admin): per-house table. Default
// order is the server order (debtors first, then the rest by margemPct);
// clicking a header sorts by that column instead, toggling asc/desc on a
// second click — same client-side sort pattern as `TeamRanking`
// (src/components/rendimento/team-ranking.tsx).
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BUCKET_LABELS } from "@/lib/billing/billing-state-summary";
import { brl } from "@/lib/format";
import type { ProviderCost } from "@/lib/billing/billing-month-report";
import type { GeneralFinanceHouse } from "@/lib/billing/general-finance.server";
import { cn } from "@/lib/utils";

type SortKey =
  | "name"
  | "bucket"
  | "mensalidade"
  | "recargas"
  | "consumo"
  | "shortBrasil"
  | "infobip"
  | "taxaPix"
  | "receitaLiquida"
  | "margem";

type SortDirection = "asc" | "desc";

const TEXT_SORT_KEYS: ReadonlySet<SortKey> = new Set(["name", "bucket"]);

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "name", label: "Casa" },
  { key: "bucket", label: "Situação" },
  { key: "mensalidade", label: "Mensalidade", align: "right" },
  { key: "recargas", label: "Recargas", align: "right" },
  { key: "consumo", label: "Consumo", align: "right" },
  { key: "shortBrasil", label: "Short Brasil", align: "right" },
  { key: "infobip", label: "Infobip", align: "right" },
  { key: "taxaPix", label: "Taxa Pix", align: "right" },
  { key: "receitaLiquida", label: "Receita líquida", align: "right" },
  { key: "margem", label: "Margem", align: "right" },
];

function consumoTotal(house: GeneralFinanceHouse): number {
  return house.consumoSms + house.consumoVoz + house.consumoEmail;
}

function sortValue(house: GeneralFinanceHouse, key: SortKey): number | string {
  switch (key) {
    case "name":
      return house.name;
    case "bucket":
      return BUCKET_LABELS[house.bucket];
    case "mensalidade":
      return house.mensalidadeReais;
    case "recargas":
      return house.topupReais;
    case "consumo":
      return consumoTotal(house);
    case "shortBrasil":
      return house.shortBrasil.amount;
    case "infobip":
      return house.infobip.amount;
    case "taxaPix":
      return house.taxaPixReais;
    case "receitaLiquida":
      return house.receitaLiquida;
    case "margem":
      return house.margemPct ?? -Infinity;
  }
}

function compareHouses(a: GeneralFinanceHouse, b: GeneralFinanceHouse, key: SortKey): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (typeof va === "string" || typeof vb === "string") {
    return String(va).localeCompare(String(vb), "pt-BR");
  }
  return va - vb;
}

function hasMissingCost(house: GeneralFinanceHouse): boolean {
  return house.shortBrasil.missingCostUnits > 0 || house.infobip.missingCostUnits > 0;
}

/** Never shows an unpriced provider cost as R$ 0: the known amount plus "+ N sem custo", or
 * "não cadastrado" when nothing is priced. */
function providerCostLabel(cost: ProviderCost): string {
  if (cost.missingCostUnits <= 0) return brl(cost.amount);
  if (cost.amount === 0) return "não cadastrado";
  return `${brl(cost.amount)} + ${cost.missingCostUnits.toLocaleString("pt-BR")} sem custo`;
}

function consumoBreakdown(house: GeneralFinanceHouse): string {
  return `SMS ${brl(house.consumoSms)} · Voz ${brl(house.consumoVoz)} · E-mail ${brl(house.consumoEmail)}`;
}

function marginLabel(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function SortHeader({
  column,
  active,
  direction,
  onSort,
}: {
  column: { key: SortKey; label: string; align?: "right" };
  active: boolean;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={column.align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          column.align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        aria-label={`Ordenar por ${column.label}`}
      >
        {column.label}
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </TableHead>
  );
}

export function GeneralFinanceTable({ houses }: { houses: GeneralFinanceHouse[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection } | null>(null);

  function handleSort(key: SortKey) {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: TEXT_SORT_KEYS.has(key) ? "asc" : "desc" },
    );
  }

  const sortedHouses = useMemo(() => {
    if (!sort) return houses;
    const copy = [...houses];
    copy.sort((a, b) => compareHouses(a, b, sort.key));
    if (sort.direction === "desc") copy.reverse();
    return copy;
  }, [houses, sort]);

  if (houses.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma casa no mês.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <SortHeader
                key={column.key}
                column={column}
                active={sort?.key === column.key}
                direction={sort?.direction ?? "desc"}
                onSort={handleSort}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedHouses.map((house) => (
            <TableRow key={house.tenantId}>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-medium">{house.name}</span>
                  {house.exempt && <Badge variant="secondary">isenta</Badge>}
                  {house.ownProvider && <Badge variant="outline">fornecedor próprio</Badge>}
                </span>
              </TableCell>
              <TableCell>{BUCKET_LABELS[house.bucket]}</TableCell>
              <TableCell className="text-right tabular-nums">
                {brl(house.mensalidadeReais)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {house.topupCount} · {brl(house.topupReais)}
              </TableCell>
              <TableCell className="text-right tabular-nums" title={consumoBreakdown(house)}>
                {brl(consumoTotal(house))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {providerCostLabel(house.shortBrasil)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {providerCostLabel(house.infobip)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{brl(house.taxaPixReais)}</TableCell>
              <TableCell className="text-right tabular-nums">{brl(house.receitaLiquida)}</TableCell>
              <TableCell
                className={cn(
                  "text-right tabular-nums",
                  house.margemPct != null && house.margemPct < 0 && "text-destructive",
                )}
              >
                {marginLabel(house.margemPct)}
                {hasMissingCost(house) && (
                  <span
                    className="ml-0.5 text-warning"
                    title="margem superestimada: custo não cadastrado"
                  >
                    *
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
