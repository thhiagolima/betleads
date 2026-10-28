// "Extrato de créditos" (Relatório de rendimento): extraído de
// `experts.$expertId.tsx` (Área do Expert, Fase 3, Task 8) como componente
// reutilizável — mesmo comportamento, agora usado tanto no relatório do
// próprio expert/perfil de equipe (sem `expertId`) quanto no relatório de
// uma pessoa vista pelo admin (com `expertId`). Ambos os casos resolvem o
// sujeito por `resolveReportSubject` (server), que já aceita `expertId`
// opcional em `listExpertCredits`/`exportExpertCreditsCsv`.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBrtDateTime } from "@/components/expert/sheet-format";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import {
  exportExpertCreditsCsv,
  listExpertCredits,
  type ExpertCreditRow,
} from "@/lib/expert-metrics.functions";
import type { PeriodKey } from "@/lib/expert-period";
import { brl } from "@/lib/format";

const CREDITS_PAGE_SIZE = 100;

// A casa ativa entra na chave (controller ruling, Task 5 fix round 1): o
// mesmo usuário pode ter o extrato de casas diferentes em cache ao trocar
// de casa no switcher, então a chave sem o tenant colidiria entre elas.
function creditStatementQueryKey(
  tenantId: string | null,
  expertId: string | undefined,
  period: PeriodKey,
  page: number,
) {
  return ["rendimento-credit-statement", tenantId, expertId ?? "self", period, page];
}

const VIA_LABEL: Record<ExpertCreditRow["via"], string> = {
  clique: "Clique",
  afiliado: "Afiliado",
};

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoga depois de um pequeno atraso: o Firefox pode cancelar o download
  // se a URL do objeto for revogada antes de a leitura do blob começar.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Cartão "Extrato de créditos": base da comissão paga por fora do sistema.
 * Tabela paginada (100 por página), total do período no topo e exportação
 * em CSV — o período vem do seletor da página que a monta. Sem `expertId`,
 * o extrato é do próprio usuário logado.
 */
export function CreditStatement({
  expertId,
  period,
}: {
  expertId?: string;
  period: PeriodKey;
}) {
  const [page, setPage] = useState(0);
  const { data: switcher } = useActiveTenant();
  const tenantId = switcher?.activeTenantId ?? null;

  const listFn = useServerFn(listExpertCredits);
  const creditsQuery = useQuery({
    queryKey: creditStatementQueryKey(tenantId, expertId, period, page),
    queryFn: () => listFn({ data: { expertId, period, page } }),
    enabled: !!tenantId,
  });

  const exportFn = useServerFn(exportExpertCreditsCsv);
  const exportMutation = useMutation({
    mutationFn: () => exportFn({ data: { expertId, period } }),
    onSuccess: (result) => {
      downloadCsv(result.filename, result.csv);
      toast.success("CSV exportado.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = creditsQuery.data?.rows ?? [];
  const total = creditsQuery.data?.total ?? 0;
  const somaValor = creditsQuery.data?.somaValor ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / CREDITS_PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Extrato de créditos</CardTitle>
          <p className="mt-1 text-body text-muted-foreground">
            Total depositado creditado: <span className="font-medium">{brl(somaValor)}</span>
          </p>
        </div>
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
        {creditsQuery.isLoading ? (
          <p className="py-6 text-center text-muted-foreground">Carregando…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum crédito no período.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Oferta</TableHead>
                  <TableHead>Clique em</TableHead>
                  <TableHead>Primeiro depósito</TableHead>
                  <TableHead>Reativação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.depositId}>
                    <TableCell>{formatBrtDateTime(row.depositAt)}</TableCell>
                    <TableCell>{row.leadNome}</TableCell>
                    <TableCell>{brl(row.valor)}</TableCell>
                    <TableCell>{VIA_LABEL[row.via]}</TableCell>
                    <TableCell>{row.oferta ?? "—"}</TableCell>
                    <TableCell>{row.clickAt ? formatBrtDateTime(row.clickAt) : "—"}</TableCell>
                    <TableCell>{row.isFtd ? "Sim" : "Não"}</TableCell>
                    <TableCell>{row.isReativacao ? "Sim" : "Não"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <nav
                aria-label="Paginação do extrato de créditos"
                className="flex items-center justify-end gap-2"
              >
                <span className="text-label text-muted-foreground" aria-live="polite">
                  Página {page + 1} de {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Página anterior"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Próxima página"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
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
