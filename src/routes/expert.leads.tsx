// Área do Expert (Fase 1, Task 9): listagem de leads visíveis pelo expert
// logado — busca por nome/telefone (com debounce) e paginação de 50.
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { brl } from "@/lib/format";
import { getExpertHome, listExpertLeads } from "@/lib/expert-leads.functions";

export const Route = createFileRoute("/expert/leads")({
  component: ExpertLeadsPage,
});

// See the matching comment in expert.index.tsx: `getExpertHome`/
// `listExpertLeads` throw `ExpertAccessError` (server-only, not imported
// here) for "no active expert access" or "house unavailable" — the second
// is shown as-is, everything else collapses to the generic message below
// so this route never leaks internal error details to a non-expert.
const HOUSE_UNAVAILABLE_MESSAGE = "Esta casa está indisponível no momento.";
const GENERIC_ACCESS_MESSAGE = "Esta área é exclusiva para experts.";

function expertAccessErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === HOUSE_UNAVAILABLE_MESSAGE) {
    return HOUSE_UNAVAILABLE_MESSAGE;
  }
  return GENERIC_ACCESS_MESSAGE;
}

function riscoBadge(risco: string) {
  if (!risco) return <span className="text-muted-foreground">—</span>;
  const variant = risco === "alto" ? "destructive" : risco === "medio" ? "secondary" : "outline";
  return <Badge variant={variant}>{risco}</Badge>;
}

function formatUltimoDeposito(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("pt-BR");
}

function ExpertLeadsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch]);

  const getExpertHomeFn = useServerFn(getExpertHome);
  const homeQuery = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => getExpertHomeFn(),
  });

  const listExpertLeadsFn = useServerFn(listExpertLeads);
  const leadsQuery = useQuery({
    queryKey: ["expert-leads", debouncedSearch, page],
    queryFn: () => listExpertLeadsFn({ data: { search: debouncedSearch, page } }),
    enabled: homeQuery.isSuccess,
    placeholderData: (previous) => previous,
  });

  if (homeQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(homeQuery.error)}
          </CardContent>
        </Card>
      </Page>
    );
  }

  const rows = leadsQuery.data?.rows ?? [];
  const total = leadsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));
  const currentPage = page + 1;
  const tipo = homeQuery.data?.tipo;

  const emptyMessage =
    debouncedSearch === "" && tipo === "restrito"
      ? "Nenhum lead chegou pelos seus IDs de afiliado ainda."
      : "Nenhum lead encontrado.";

  return (
    <Page>
      <PageHeader />

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nome ou telefone..."
              className="pl-9"
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Dias sem depositar</TableHead>
                <TableHead>Total depositado</TableHead>
                <TableHead>Último depósito</TableHead>
                <TableHead>Risco</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.nome}</TableCell>
                  <TableCell>{row.telefone ?? "—"}</TableCell>
                  <TableCell>{row.diasSemDepositar ?? "—"}</TableCell>
                  <TableCell>{brl(row.totalDepositado)}</TableCell>
                  <TableCell>{formatUltimoDeposito(row.ultimoDeposito)}</TableCell>
                  <TableCell>{riscoBadge(row.risco)}</TableCell>
                </TableRow>
              ))}
              {!leadsQuery.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {total > 50 && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <span className="text-xs text-muted-foreground">
                Página {currentPage} de {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Página anterior"
                  disabled={page === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Próxima página"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
