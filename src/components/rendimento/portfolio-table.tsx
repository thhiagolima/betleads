// Relatório de rendimento, blocos 4 e 6 (spec §4): "Leads que mais
// depositaram" (top 10, vem pronto em `getExpertReport`) e "Leads do período"
// (a carteira: busca com debounce, "Só FTD", "Só reativados", 50 por página e
// CSV). Clicar num lead abre o histórico (`LeadHistorySheet`) pela página.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBrtDate } from "@/components/expert/sheet-format";
import { downloadCsv } from "@/components/rendimento/download-csv";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { CONTATO_LABEL, type ContatoResultado } from "@/lib/expert-lead-labels";
import type { PeriodKey } from "@/lib/expert-period";
import {
  exportExpertPortfolioCsv,
  listExpertPortfolio,
  type PortfolioRow,
} from "@/lib/expert-report.functions";
import { brl, num } from "@/lib/format";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX_LENGTH = 80;

export type LeadRef = { playerId: string; nome: string };

const ORIGEM_LABEL: Record<PortfolioRow["origem"], string> = {
  clique: "Clique",
  afiliado: "Afiliado",
  ambos: "Ambos",
};

function LeadMarks({ row }: { row: PortfolioRow }) {
  if (!row.temFtd && !row.reativado) return null;
  return (
    <span className="inline-flex gap-1">
      {row.temFtd && <Badge variant="secondary">FTD</Badge>}
      {row.reativado && <Badge variant="outline">Reativado</Badge>}
    </span>
  );
}

function LeadButton({ row, onOpen }: { row: PortfolioRow; onOpen: (lead: LeadRef) => void }) {
  return (
    <button
      type="button"
      className="text-left font-medium hover:underline"
      onClick={() => onOpen({ playerId: row.playerId, nome: row.nome })}
    >
      {row.nome}
    </button>
  );
}

function contatoText(contato: PortfolioRow["ultimoContato"]): string {
  if (!contato) return "—";
  const label = CONTATO_LABEL[contato.resultado as ContatoResultado] ?? contato.resultado;
  return `${label} · ${formatBrtDate(contato.em)}`;
}

/** Bloco 4: top 10 por valor creditado no período. */
export function TopLeadsCard({
  rows,
  onOpenLead,
}: {
  rows: PortfolioRow[];
  onOpenLead: (lead: LeadRef) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads que mais depositaram</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            Nenhum lead com crédito neste período.
          </p>
        ) : (
          <ol className="divide-y divide-border/70">
            {rows.map((row, index) => (
              <li key={row.playerId} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-5 shrink-0 text-label text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <LeadButton row={row} onOpen={onOpenLead} />
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-medium tabular-nums">{brl(row.creditado)}</span>
                  <span className="block text-label text-muted-foreground">
                    {num(row.depositos)} {row.depositos === 1 ? "depósito" : "depósitos"} ·{" "}
                    {ORIGEM_LABEL[row.origem]}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function FilterToggle({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? "secondary" : "outline"}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}

/** Bloco 6: a carteira da pessoa no período. */
export function PortfolioTable({
  expertId,
  period,
  onOpenLead,
}: {
  expertId?: string;
  period: PeriodKey;
  onOpenLead: (lead: LeadRef) => void;
}) {
  const { data: switcher } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [onlyFtd, setOnlyFtd] = useState(false);
  const [onlyReativados, setOnlyReativados] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // A página volta para a primeira sempre que o período ou um filtro muda.
  const filtersKey = JSON.stringify([
    tenantId,
    expertId ?? "self",
    period,
    search,
    onlyFtd,
    onlyReativados,
  ]);
  const [pageState, setPageState] = useState({ key: filtersKey, page: 0 });
  const page = pageState.key === filtersKey ? pageState.page : 0;
  const setPage = (next: number) => setPageState({ key: filtersKey, page: next });

  const filters = {
    expertId,
    period,
    search: search || undefined,
    onlyFtd,
    onlyReativados,
  };

  const listFn = useServerFn(listExpertPortfolio);
  const portfolioQuery = useQuery({
    queryKey: [
      "rendimento-portfolio",
      tenantId,
      expertId ?? "self",
      period,
      search,
      onlyFtd,
      onlyReativados,
      page,
    ],
    queryFn: () => listFn({ data: { ...filters, page } }),
    enabled: !!tenantId,
  });

  const exportFn = useServerFn(exportExpertPortfolioCsv);
  const exportMutation = useMutation({
    mutationFn: () => exportFn({ data: filters }),
    onSuccess: (result) => {
      downloadCsv(result.filename, result.csv);
      toast.success("CSV exportado.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = portfolioQuery.data?.rows ?? [];
  const total = portfolioQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const loadedTotal = portfolioQuery.data ? total : null;

  // O total pode cair entre uma página e outra (créditos recalculados): fora
  // do fim, volta para a última página válida (ou a primeira, quando a
  // página pedida já veio vazia e sem total).
  useEffect(() => {
    if (loadedTotal === null) return;
    const lastPage = Math.max(0, Math.ceil(loadedTotal / PAGE_SIZE) - 1);
    if (page > lastPage) setPageState({ key: filtersKey, page: lastPage });
  }, [loadedTotal, page, filtersKey]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Leads do período</CardTitle>
        <Button
          variant="outline"
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending}
        >
          <Download className="mr-2 h-4 w-4" />
          {exportMutation.isPending ? "Exportando…" : "Exportar CSV"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Buscar por nome ou telefone"
              aria-label="Buscar por nome ou telefone"
              maxLength={SEARCH_MAX_LENGTH}
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <FilterToggle pressed={onlyFtd} onToggle={() => setOnlyFtd((v) => !v)}>
              Só FTD
            </FilterToggle>
            <FilterToggle pressed={onlyReativados} onToggle={() => setOnlyReativados((v) => !v)}>
              Só reativados
            </FilterToggle>
          </div>
        </div>

        {portfolioQuery.isLoading ? (
          <p className="py-6 text-center text-muted-foreground">Carregando…</p>
        ) : portfolioQuery.isError ? (
          <p className="py-6 text-center text-muted-foreground">{portfolioQuery.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            Nenhum lead com crédito neste período.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Creditado</TableHead>
                  <TableHead>Depósitos</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>1º crédito</TableHead>
                  <TableHead>Último depósito</TableHead>
                  <TableHead>Último contato</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.playerId}>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <LeadButton row={row} onOpen={onOpenLead} />
                        <LeadMarks row={row} />
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{brl(row.creditado)}</TableCell>
                    <TableCell className="tabular-nums">{num(row.depositos)}</TableCell>
                    <TableCell>{ORIGEM_LABEL[row.origem]}</TableCell>
                    <TableCell>{formatBrtDate(row.primeiroCredito)}</TableCell>
                    <TableCell>
                      {row.ultimoDeposito ? formatBrtDate(row.ultimoDeposito) : "—"}
                    </TableCell>
                    <TableCell>{contatoText(row.ultimoContato)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <nav
                aria-label="Paginação dos leads do período"
                className="flex items-center justify-end gap-2"
              >
                <span className="text-label text-muted-foreground" aria-live="polite">
                  Página {page + 1} de {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Página anterior"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Próxima página"
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
