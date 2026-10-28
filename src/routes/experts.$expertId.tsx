// Admin "Expert" detail (Área do Expert, Fase 3, Task 6): header (name,
// type, access badge, "Editar"), period picker + `ExpertMetricCards`, a
// stacked daily bar chart (por clique / por afiliado) and three activity
// cards — "Links gerados", "Contatos registrados" and "Leads assumidos".
// Child route of `/experts` (experts.tsx renders only <Outlet /> here, like
// expert.leads.tsx does for its sheet). Not found -> "Expert não
// encontrado." with a link back to the list.
import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { CentralPeriodPicker } from "@/components/crm-results/shared";
import { ExpertMetricCards } from "@/components/expert/expert-metric-cards";
import { formatBrtDateTime } from "@/components/expert/sheet-format";
import { chartAxisProps, chartGridProps, CHART_COLORS } from "@/lib/chart-theme";
import {
  exportExpertCreditsCsv,
  getExpertDetail,
  listExpertCredits,
  type ExpertCreditRow,
} from "@/lib/expert-metrics.functions";
import { DEFAULT_EXPERT_PERIOD, type PeriodKey } from "@/lib/expert-period";
import { brl } from "@/lib/format";
import { expertCreditsQueryKey, expertDetailQueryKey } from "@/components/experts/experts-query";
import { ExpertFormDialog } from "@/components/experts/expert-form-dialog";
import { acessoBadge, TIPO_LABEL } from "@/components/experts/expert-badges";

const CREDITS_PAGE_SIZE = 100;

export const Route = createFileRoute("/experts/$expertId")({
  component: ExpertDetailPage,
});

/** "aaaa-mm-dd" (dia da série) -> "dd/mm". */
function dayLabel(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

const CHART_CONFIG: ChartConfig = {
  depositadoClique: { label: "Por clique", color: CHART_COLORS.primary },
  depositadoAfiliado: { label: "Por afiliado", color: CHART_COLORS.violet },
};

function DailyChart({
  serie,
}: {
  serie: { dia: string; depositadoClique: number; depositadoAfiliado: number }[];
}) {
  const allZero = serie.every((d) => d.depositadoClique === 0 && d.depositadoAfiliado === 0);
  if (allZero) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Depositado por dia</CardTitle>
        </CardHeader>
        <CardContent className="py-10 text-center text-muted-foreground">
          Nenhum depósito atribuído no período.
        </CardContent>
      </Card>
    );
  }

  const points = serie.map((d) => ({
    dia: dayLabel(d.dia),
    depositadoClique: d.depositadoClique,
    depositadoAfiliado: d.depositadoAfiliado,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Depositado por dia</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={CHART_CONFIG} className="aspect-auto h-72 w-full">
          <BarChart data={points}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="dia" {...chartAxisProps} />
            <YAxis {...chartAxisProps} width={80} tickFormatter={(value) => brl(Number(value))} />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => brl(Number(value))} labelKey="dia" />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="depositadoClique"
              stackId="depositado"
              fill={CHART_COLORS.primary}
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="depositadoAfiliado"
              stackId="depositado"
              fill={CHART_COLORS.violet}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function LinksCard({
  links,
}: {
  links: { id: string; oferta: string; leadNome: string; createdAt: string; clicado: boolean }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Links gerados</CardTitle>
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum link gerado.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {links.map((link) => (
              <li key={link.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="text-body font-medium">{link.oferta}</span>
                  <span className="ml-2 text-label text-muted-foreground">{link.leadNome}</span>
                  <span className="ml-2 text-label text-muted-foreground">
                    {formatBrtDateTime(link.createdAt)}
                  </span>
                </span>
                <span className="shrink-0 text-label text-muted-foreground">
                  {link.clicado ? "Clicou" : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ContactsCard({
  contatos,
}: {
  contatos: { leadNome: string; resultado: string; createdAt: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contatos registrados</CardTitle>
      </CardHeader>
      <CardContent>
        {contatos.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum contato registrado.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {contatos.map((contato, index) => (
              <li
                key={`${contato.leadNome}-${contato.createdAt}-${index}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <span className="min-w-0">
                  <span className="text-body font-medium">{contato.leadNome}</span>
                  <span className="ml-2 text-label text-muted-foreground">{contato.resultado}</span>
                </span>
                <span className="shrink-0 text-label text-muted-foreground">
                  {formatBrtDateTime(contato.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ClaimsCard({ assumidos }: { assumidos: { leadNome: string; expiresAt: string }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads assumidos</CardTitle>
      </CardHeader>
      <CardContent>
        {assumidos.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">Nenhum lead assumido agora.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {assumidos.map((claim, index) => (
              <li
                key={`${claim.leadNome}-${claim.expiresAt}-${index}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <span className="text-body font-medium">{claim.leadNome}</span>
                <span className="shrink-0 text-label text-muted-foreground">
                  até {formatBrtDateTime(claim.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

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

const VIA_LABEL: Record<ExpertCreditRow["via"], string> = {
  clique: "Clique",
  afiliado: "Afiliado",
};

/**
 * Cartão "Extrato de créditos" (Fase 3, Task 8): base da comissão paga por
 * fora do sistema. Tabela paginada (100 por página), total do período no
 * topo e exportação em CSV — o período vem do seletor da página.
 */
function CreditsCard({ expertId, period }: { expertId: string; period: PeriodKey }) {
  const [page, setPage] = useState(0);

  const listFn = useServerFn(listExpertCredits);
  const creditsQuery = useQuery({
    queryKey: expertCreditsQueryKey(expertId, period, page),
    queryFn: () => listFn({ data: { expertId, period, page } }),
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

function ExpertDetailPage() {
  const { expertId } = Route.useParams();
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_EXPERT_PERIOD);
  const [editOpen, setEditOpen] = useState(false);

  const getDetailFn = useServerFn(getExpertDetail);
  const detailQuery = useQuery({
    queryKey: expertDetailQueryKey(expertId, period),
    queryFn: () => getDetailFn({ data: { expertId, period } }),
  });

  if (detailQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="space-y-3 py-12 text-center text-muted-foreground">
            <p>{detailQuery.error instanceof Error ? detailQuery.error.message : "Expert não encontrado."}</p>
            <Button asChild variant="outline">
              <Link to="/experts">Voltar para Experts</Link>
            </Button>
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (detailQuery.isLoading || !detailQuery.data) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Carregando…</CardContent>
        </Card>
      </Page>
    );
  }

  const { expert, metrics, serie, links, contatos, assumidos } = detailQuery.data;

  return (
    <Page>
      <PageHeader
        title={expert.nome}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{TIPO_LABEL[expert.tipo]}</Badge>
            {acessoBadge(expert.acesso, expert.papelEquipe, expert.ativo)}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CentralPeriodPicker value={period} onChange={setPeriod} />
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              Editar
            </Button>
          </div>
        }
      />

      <ExpertMetricCards metrics={metrics} />
      <DailyChart serie={serie} />
      {/* `key={period}` reinicia a página do extrato ao trocar o período. */}
      <CreditsCard key={period} expertId={expertId} period={period} />

      <div className="grid gap-3 lg:grid-cols-3">
        <LinksCard links={links} />
        <ContactsCard contatos={contatos} />
        <ClaimsCard assumidos={assumidos} />
      </div>

      <ExpertFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        expert={expert}
        initialAffiliateId={null}
        unassignedAffiliates={[]}
      />
    </Page>
  );
}
