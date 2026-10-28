// Área do Expert (Fase 1, Task 9; cartão "Para chamar hoje" na Fase 2, Task
// 8; números do período, gráfico diário e lista completa na Fase 3, Task 5):
// tela "Início" do expert — saudação, tipo de acesso e casa, seletor de
// período, cartões de métricas (`ExpertMetricCards`), gráfico de depositado
// por dia, a lista "Para chamar hoje" (retornos, entraram em risco, clicaram
// e não depositaram) e o total de leads visíveis com um botão para a
// listagem (/expert/leads).
import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { CentralPeriodPicker } from "@/components/crm-results/shared";
import { actionErrorMessage, formatDueDate } from "@/components/expert/sheet-format";
import { ExpertMetricCards } from "@/components/expert/expert-metric-cards";
import { CHART_COLORS, chartAxisProps, chartGridProps } from "@/lib/chart-theme";
import { expertAccessErrorMessage } from "@/lib/expert-access-message";
import {
  completeExpertFollowup,
  listExpertClickedNoDeposit,
  listExpertFollowupsDue,
  listExpertLeadsEnteredRisk,
  type ExpertFollowupDue,
  type ExpertLeadClickedNoDeposit,
  type ExpertLeadEnteredRisk,
} from "@/lib/expert-lead-actions.functions";
import { getExpertHome } from "@/lib/expert-leads.functions";
import { getExpertDashboard } from "@/lib/expert-metrics.functions";
import { DEFAULT_EXPERT_PERIOD, EXPERT_PERIODS, type PeriodKey } from "@/lib/expert-period";
import { brl, num } from "@/lib/format";

const FOLLOWUPS_DUE_QUERY_KEY = ["expert-followups-due"];
const ENTERED_RISK_QUERY_KEY = ["expert-leads-entered-risk"];
const CLICKED_NO_DEPOSIT_QUERY_KEY = ["expert-clicked-no-deposit"];

/** "aaaa-mm-dd" (dia da série) -> "dd/mm". */
function dayLabel(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** Instante ISO -> "hh:mm" no fuso de São Paulo. */
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const CHART_CONFIG: ChartConfig = {
  depositado: { label: "Depositado", color: CHART_COLORS.primary },
};

function DepositedChart({ serie }: { serie: { dia: string; depositado: number }[] }) {
  if (serie.every((d) => d.depositado === 0)) {
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

  const points = serie.map((d) => ({ dia: dayLabel(d.dia), depositado: d.depositado }));

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
              content={
                <ChartTooltipContent
                  formatter={(value) => brl(Number(value))}
                  labelKey="dia"
                  nameKey="depositado"
                />
              }
            />
            <Bar dataKey="depositado" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function RetornosSection({ followups }: { followups: ExpertFollowupDue[] }) {
  const qc = useQueryClient();
  const completeFn = useServerFn(completeExpertFollowup);
  const complete = useMutation({
    mutationFn: (id: string) => completeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Retorno concluído.");
      qc.invalidateQueries({ queryKey: FOLLOWUPS_DUE_QUERY_KEY });
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  if (followups.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1.5 text-label font-medium text-muted-foreground">Retornos</h3>
      <ul className="divide-y divide-border/70">
        {followups.map((followup: ExpertFollowupDue) => (
          <li key={followup.id} className="flex items-center justify-between gap-3 py-2.5">
            <Link
              to="/expert/leads/$playerId"
              params={{ playerId: followup.playerId }}
              className="min-w-0 hover:underline"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium">{followup.nome}</span>
                {followup.atrasado && (
                  <Badge variant="destructive">Atrasado · {formatDueDate(followup.dueDate)}</Badge>
                )}
              </span>
              {followup.nota && (
                <p className="mt-0.5 truncate text-label text-muted-foreground">{followup.nota}</p>
              )}
            </Link>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={complete.isPending}
              onClick={() => complete.mutate(followup.id)}
            >
              Concluir
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EnteredRiskSection({ leads }: { leads: ExpertLeadEnteredRisk[] }) {
  if (leads.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1.5 text-label font-medium text-muted-foreground">Entraram em risco</h3>
      <ul className="divide-y divide-border/70">
        {leads.map((lead: ExpertLeadEnteredRisk) => (
          <li key={lead.playerId} className="py-2.5">
            <Link
              to="/expert/leads/$playerId"
              params={{ playerId: lead.playerId }}
              className="flex items-center justify-between gap-3 hover:underline"
            >
              <span className="text-body font-medium">{lead.nome}</span>
              <span className="shrink-0 text-label text-muted-foreground">
                {lead.diasSemDepositar} {lead.diasSemDepositar === 1 ? "dia" : "dias"} sem depositar
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClickedNoDepositSection({ leads }: { leads: ExpertLeadClickedNoDeposit[] }) {
  if (leads.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1.5 text-label font-medium text-muted-foreground">
        Clicaram no seu link e não depositaram (24h)
      </h3>
      <ul className="divide-y divide-border/70">
        {leads.map((lead: ExpertLeadClickedNoDeposit) => (
          <li key={lead.playerId} className="py-2.5">
            <Link
              to="/expert/leads/$playerId"
              params={{ playerId: lead.playerId }}
              className="flex items-center justify-between gap-3 hover:underline"
            >
              <span className="min-w-0">
                <span className="text-body font-medium">{lead.nome}</span>
                {lead.oferta && (
                  <span className="ml-2 text-label text-muted-foreground">{lead.oferta}</span>
                )}
              </span>
              <span className="shrink-0 text-label text-muted-foreground">
                {timeLabel(lead.clicadoEm)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParaChamarHojeCard() {
  const listFollowupsFn = useServerFn(listExpertFollowupsDue);
  const followupsQuery = useQuery({
    queryKey: FOLLOWUPS_DUE_QUERY_KEY,
    queryFn: () => listFollowupsFn(),
  });

  const listRiskFn = useServerFn(listExpertLeadsEnteredRisk);
  const riskQuery = useQuery({
    queryKey: ENTERED_RISK_QUERY_KEY,
    queryFn: () => listRiskFn(),
  });

  const listClickedFn = useServerFn(listExpertClickedNoDeposit);
  const clickedQuery = useQuery({
    queryKey: CLICKED_NO_DEPOSIT_QUERY_KEY,
    queryFn: () => listClickedFn(),
  });

  const loading = followupsQuery.isLoading || riskQuery.isLoading || clickedQuery.isLoading;
  const followups = followupsQuery.data ?? [];
  const risk = riskQuery.data ?? [];
  const clicked = clickedQuery.data ?? [];
  const allEmpty = !loading && followups.length === 0 && risk.length === 0 && clicked.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Para chamar hoje</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading && <p className="py-6 text-center text-muted-foreground">Carregando…</p>}
        {allEmpty && (
          <p className="py-6 text-center text-muted-foreground">Nada para hoje. Bom trabalho!</p>
        )}
        {!loading && !allEmpty && (
          <>
            <RetornosSection followups={followups} />
            <EnteredRiskSection leads={risk} />
            <ClickedNoDepositSection leads={clicked} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/expert/")({
  component: ExpertHomePage,
});

const TIPO_LABEL: Record<"restrito" | "total", string> = {
  restrito: "Restrito",
  total: "Acesso total",
};

function ExpertHomePage() {
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_EXPERT_PERIOD);

  const getExpertHomeFn = useServerFn(getExpertHome);
  const homeQuery = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => getExpertHomeFn(),
  });

  const getExpertDashboardFn = useServerFn(getExpertDashboard);
  const dashboardQuery = useQuery({
    queryKey: ["expert-dashboard", period],
    queryFn: () => getExpertDashboardFn({ data: { period } }),
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

  if (homeQuery.isLoading || !homeQuery.data) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Carregando…</CardContent>
        </Card>
      </Page>
    );
  }

  const { nome, tipo, tenantNome, totalLeads } = homeQuery.data;

  return (
    <Page>
      <PageHeader
        title={`Olá, ${nome}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{TIPO_LABEL[tipo]}</Badge>
            <span>{tenantNome}</span>
          </span>
        }
        actions={
          <CentralPeriodPicker value={period} onChange={setPeriod} periods={EXPERT_PERIODS} />
        }
      />

      {dashboardQuery.data && (
        <>
          <ExpertMetricCards metrics={dashboardQuery.data.metrics} />
          <DepositedChart serie={dashboardQuery.data.serie} />
          <p className="text-xs text-muted-foreground">
            Depósitos contam para você quando o lead clica no seu link e deposita em até{" "}
            {dashboardQuery.data.janelaHoras}h, ou quando chega pelo seu ID de afiliado.
          </p>
        </>
      )}

      <ParaChamarHojeCard />

      <Card className="w-fit">
        <CardHeader>
          <CardTitle>Seus leads: {num(totalLeads)}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild className="gap-2">
            <Link to="/expert/leads">
              Ver leads
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </Page>
  );
}
