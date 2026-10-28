// "Rendimento da equipe" (spec §5): ranking dos perfis da casa (experts e
// equipe, inclusive inativos). Cabeçalhos ordenáveis no cliente, sobre as
// linhas já carregadas (sem nova chamada ao servidor) — padrão creditado
// decrescente. O nome leva ao relatório da pessoa
// (/rendimento/equipe/$expertId).
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VariationTag } from "@/components/rendimento/report-cards";
import { CLIQUE_DEPOSITO_DEFINICAO } from "@/components/rendimento/report-funnel";
import type { TeamReportRow } from "@/lib/expert-report.functions";
import { brl, num } from "@/lib/format";

// Exportada para a rota /rendimento/equipe (query key) e para a "Regras de
// crédito" dialog invalidar o ranking depois de salvar a janela de clique.
export const TEAM_REPORT_QUERY_KEY = "rendimento-equipe";

type SortKey =
  | "nome"
  | "tipoLabel"
  | "creditado"
  | "variacao"
  | "ftds"
  | "redepositos"
  | "reativados"
  | "cliqueDeposito"
  | "ticket";

type SortDirection = "asc" | "desc";

const TEXT_SORT_KEYS: ReadonlySet<SortKey> = new Set(["nome", "tipoLabel"]);

const DEFAULT_SORT: { key: SortKey; direction: SortDirection } = {
  key: "creditado",
  direction: "desc",
};

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "nome", label: "Pessoa" },
  { key: "tipoLabel", label: "Tipo" },
  { key: "creditado", label: "Creditado", align: "right" },
  { key: "variacao", label: "Variação vs período anterior", align: "right" },
  { key: "ftds", label: "FTD", align: "right" },
  { key: "redepositos", label: "Redepósitos", align: "right" },
  { key: "reativados", label: "Reativados", align: "right" },
  { key: "cliqueDeposito", label: "Clique→depósito (%)", align: "right" },
  { key: "ticket", label: "Ticket médio", align: "right" },
];

/** Valor numérico de `key` para uma linha, com `null` tratado como o menor valor. */
function sortValue(row: TeamReportRow, key: SortKey): number | string {
  switch (key) {
    case "nome":
      return row.nome;
    case "tipoLabel":
      return row.tipoLabel;
    case "creditado":
      return row.creditado;
    case "variacao":
      return row.variacao ?? -Infinity;
    case "ftds":
      return row.ftds;
    case "redepositos":
      return row.redepositos;
    case "reativados":
      return row.reativados;
    case "cliqueDeposito":
      return row.cliqueDeposito ?? -Infinity;
    case "ticket":
      return row.ticket ?? -Infinity;
  }
}

function compareRows(a: TeamReportRow, b: TeamReportRow, key: SortKey): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (typeof va === "string" || typeof vb === "string") {
    return String(va).localeCompare(String(vb), "pt-BR");
  }
  return va - vb;
}

/** Fração -> "12,5%", exibida no máximo 100% (ver `CLIQUE_DEPOSITO_DEFINICAO`). */
export function pctLabel(fraction: number | null): string {
  if (fraction === null) return "—";
  const value = Math.min(100, fraction * 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${value}%`;
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
        className={`inline-flex items-center gap-1 ${
          column.align === "right" ? "flex-row-reverse" : ""
        } hover:text-foreground ${active ? "text-foreground" : "text-muted-foreground"}`}
        aria-label={`Ordenar por ${column.label}`}
      >
        {column.label}
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </TableHead>
  );
}

/** Ranking da equipe (spec §5): colunas, ordenação no cliente e badge "Inativo". */
export function TeamRanking({ rows }: { rows: TeamReportRow[] }) {
  const [sort, setSort] = useState(DEFAULT_SORT);

  function handleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: TEXT_SORT_KEYS.has(key) ? "asc" : "desc" },
    );
  }

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => compareRows(a, b, sort.key));
    if (sort.direction === "desc") copy.reverse();
    return copy;
  }, [rows, sort]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ranking</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum perfil cadastrado.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => (
                  <SortHeader
                    key={column.key}
                    column={column}
                    active={sort.key === column.key}
                    direction={sort.direction}
                    onSort={handleSort}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.map((row) => (
                <TableRow key={row.expertId}>
                  <TableCell className="font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Link
                        to="/rendimento/equipe/$expertId"
                        params={{ expertId: row.expertId }}
                        className="hover:underline"
                      >
                        {row.nome}
                      </Link>
                      {!row.ativo && <Badge variant="destructive">Inativo</Badge>}
                    </span>
                  </TableCell>
                  <TableCell>{row.tipoLabel}</TableCell>
                  <TableCell className="text-right tabular-nums">{brl(row.creditado)}</TableCell>
                  <TableCell className="text-right">
                    <VariationTag value={row.variacao} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(row.ftds)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(row.redepositos)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(row.reativados)}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums"
                    title={CLIQUE_DEPOSITO_DEFINICAO}
                  >
                    {pctLabel(row.cliqueDeposito)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.ticket === null ? "—" : brl(row.ticket)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
