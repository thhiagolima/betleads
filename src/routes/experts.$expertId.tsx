// Admin "Expert" detail (Área do Expert, Fase 3, Task 6): header (name,
// type, access badge, "Editar"), period picker + `ExpertMetricCards`, a
// stacked daily bar chart (por clique / por afiliado) and three activity
// cards — "Links gerados", "Contatos registrados" and "Leads assumidos".
// Child route of `/experts` (experts.tsx renders only <Outlet /> here, like
// expert.leads.tsx does for its sheet). Not found -> "Expert não
// encontrado." with a link back to the list.
import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

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
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { CentralPeriodPicker } from "@/components/crm-results/shared";
import { ExpertMetricCards } from "@/components/expert/expert-metric-cards";
import { formatBrtDateTime } from "@/components/expert/sheet-format";
import { chartAxisProps, chartGridProps, CHART_COLORS } from "@/lib/chart-theme";
import { getExpertDetail } from "@/lib/expert-metrics.functions";
import { DEFAULT_EXPERT_PERIOD, type PeriodKey } from "@/lib/expert-period";
import { brl } from "@/lib/format";
import { expertDetailQueryKey } from "@/components/experts/experts-query";
import { ExpertFormDialog } from "@/components/experts/expert-form-dialog";
import { acessoBadge, TIPO_LABEL } from "@/components/experts/expert-badges";

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
