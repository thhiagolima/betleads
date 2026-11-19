// Área do Expert (Fase 1, Task 9): listagem de leads visíveis pelo expert
// logado — busca por nome/telefone (com debounce) e paginação de 50. Cada
// linha abre a ficha do lead (/expert/leads/$playerId, rota filha).
import { useEffect, useState } from "react";
import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
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
import { useMoney } from "@/hooks/use-tenant-currency";
import { expertAccessErrorMessage } from "@/lib/expert-access-message";
import { getExpertHome, listExpertLeads } from "@/lib/expert-leads.functions";

export const Route = createFileRoute("/expert/leads")({
  component: ExpertLeadsRoute,
});

/** A ficha é rota filha: nela só o <Outlet />, sem montar (nem buscar) a lista. */
function ExpertLeadsRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSheetRoute = pathname.replace(/\/+$/, "") !== "/expert/leads";
  return isSheetRoute ? <Outlet /> : <ExpertLeadsPage />;
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
  const navigate = useNavigate();
  const { money } = useMoney();
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

          {leadsQuery.isError && !leadsQuery.data ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center" role="alert">
              <p className="text-body text-destructive">Não foi possível carregar os leads.</p>
              <Button variant="outline" size="sm" onClick={() => void leadsQuery.refetch()}>
                Tentar novamente
              </Button>
            </div>
          ) : !homeQuery.isSuccess || leadsQuery.isLoading ? (
            <p className="py-8 text-center text-muted-foreground" aria-busy="true">
              Carregando leads…
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">{emptyMessage}</p>
          ) : (
            <>
              {/* Phones: one card per lead, the whole card opens the sheet. */}
              <ul className="space-y-2 md:hidden">
                {rows.map((row) => (
                  <li key={row.id}>
                    <Link
                      to="/expert/leads/$playerId"
                      params={{ playerId: row.id }}
                      className="flex min-h-11 items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5 hover:bg-muted/40"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium">{row.nome}</span>
                        <span className="block truncate text-label text-muted-foreground">
                          {row.telefone ?? "Sem telefone"}
                        </span>
                        <span className="mt-0.5 block text-label text-muted-foreground">
                          {money(row.totalDepositado)} depositado
                          {row.diasSemDepositar != null &&
                            ` · ${row.diasSemDepositar} ${row.diasSemDepositar === 1 ? "dia" : "dias"} sem depositar`}
                        </span>
                      </span>
                      {row.risco && <span className="shrink-0">{riscoBadge(row.risco)}</span>}
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="hidden md:block">
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
                      <TableRow
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() =>
                          void navigate({
                            to: "/expert/leads/$playerId",
                            params: { playerId: row.id },
                          })
                        }
                      >
                        <TableCell className="font-medium">
                          <Link
                            to="/expert/leads/$playerId"
                            params={{ playerId: row.id }}
                            className="hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {row.nome}
                          </Link>
                        </TableCell>
                        <TableCell>{row.telefone ?? "—"}</TableCell>
                        <TableCell>{row.diasSemDepositar ?? "—"}</TableCell>
                        <TableCell>{money(row.totalDepositado)}</TableCell>
                        <TableCell>{formatUltimoDeposito(row.ultimoDeposito)}</TableCell>
                        <TableCell>{riscoBadge(row.risco)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {total > 50 && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <span className="text-meta text-muted-foreground">
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
