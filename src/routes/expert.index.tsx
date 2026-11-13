// Área do Expert (Fase 1, Task 9; cartão "Para chamar hoje" na Fase 2, Task
// 8; relatório de rendimento, Task 6): tela "Início" do expert. O topo tem a
// mesma cara do Início da casa (blocos de dashboard-blocks.tsx: os 4
// cartões com tendência, depósitos e saques por dia ou por hora, Recuperado,
// métricas secundárias e Ao vivo, com o mesmo seletor de período), mas só com
// os números dos leads do expert (`getExpertHomeSummary`: restrito = os
// affiliate_ids dele, total = a casa inteira). Sem o que é só da casa
// (checklist de configuração, aviso de domínio, gasto e envios de SMS,
// retorno sobre o envio, jornadas ativas/total, saldo). Abaixo ficam os blocos
// do expert: "Para chamar hoje" (retornos, entraram em risco, clicaram e não
// depositaram), o consumo do mês, o total de leads com o botão para
// /expert/leads e o atalho "Ver relatório completo" (/expert/rendimento,
// créditos e comissão).
import { useMemo } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";

import {
  CashflowCrmRow,
  DashboardError,
  DashboardSkeleton,
  HomeHeader,
  HomeKpiCards,
  LiveFeed,
  SecondaryMetrics,
} from "@/components/home/dashboard-blocks";
import { HomeCard } from "@/components/home/home-cards";
import { PeriodPicker } from "@/components/home/period-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { actionErrorMessage, formatDueDate } from "@/components/expert/sheet-format";
import { ExpertUsageCard } from "@/components/campaigns/expert-usage-card";
import { getExpertCampaignUsage } from "@/lib/expert-campaigns.functions";
import { EXPERT_USAGE_QUERY_KEY, type ExpertCampaignUsageData } from "@/lib/expert-campaign-usage";
import { HOUSE_UNAVAILABLE_MESSAGE, expertAccessErrorMessage } from "@/lib/expert-access-message";
import {
  completeExpertFollowup,
  listExpertClickedNoDeposit,
  listExpertFollowupsDue,
  listExpertLeadsEnteredRisk,
  type ExpertFollowupDue,
  type ExpertLeadClickedNoDeposit,
  type ExpertLeadEnteredRisk,
} from "@/lib/expert-lead-actions.functions";
import { getExpertHomeSummary } from "@/lib/expert-home.functions";
import { getExpertHome } from "@/lib/expert-leads.functions";
import { num } from "@/lib/format";
import { greetingFor } from "@/lib/home-dashboard";
import { brtDayKeyLocal, useHomePeriod } from "@/hooks/use-home-period";
import { POLL_INTERVALS, useUpdatedAgo } from "@/hooks/use-updated-ago";

const FOLLOWUPS_DUE_QUERY_KEY = ["expert-followups-due"];
const ENTERED_RISK_QUERY_KEY = ["expert-leads-entered-risk"];
const CLICKED_NO_DEPOSIT_QUERY_KEY = ["expert-clicked-no-deposit"];

/** Instante ISO -> "hh:mm" no fuso de São Paulo. */
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
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

/** Sending cap of the month (used x cap + waiting for approval), linking to Campanhas. */
function MeuConsumoCard() {
  const usageFn = useServerFn(getExpertCampaignUsage);
  const usage = useQuery({ queryKey: EXPERT_USAGE_QUERY_KEY, queryFn: () => usageFn() });
  return (
    <ExpertUsageCard
      title="Meu consumo"
      usage={usage.data as ExpertCampaignUsageData | undefined}
      loading={usage.isLoading}
      failed={usage.isError}
      className="max-w-xl"
      action={
        <Button asChild variant="outline" size="sm" className="gap-2">
          <Link to="/campanhas">
            Ver campanhas
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      }
    />
  );
}

/** Erro do resumo: casa indisponível como veio; o resto, uma mensagem genérica. */
function summaryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === HOUSE_UNAVAILABLE_MESSAGE) return error.message;
  return "Não foi possível carregar os dados do painel.";
}

function ExpertHomePage() {
  const period = useHomePeriod();
  const { from, to, includesToday } = period;

  const getExpertHomeFn = useServerFn(getExpertHome);
  const homeQuery = useQuery({
    queryKey: ["expert-home"],
    queryFn: () => getExpertHomeFn(),
  });

  const getSummaryFn = useServerFn(getExpertHomeSummary);
  const summaryQuery = useQuery({
    queryKey: ["expert-home-summary", brtDayKeyLocal(from), brtDayKeyLocal(to)],
    queryFn: () => getSummaryFn({ data: { from: from.toISOString(), to: to.toISOString() } }),
    enabled: homeQuery.isSuccess,
    staleTime: includesToday ? 20_000 : 5 * 60_000,
    refetchInterval: includesToday ? POLL_INTERVALS.dashboard : false,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const updatedAgo = useUpdatedAgo(summaryQuery.dataUpdatedAt || undefined);
  const greeting = useMemo(() => greetingFor(), []);
  const data = summaryQuery.data;
  const sparkline = useMemo(
    () => (data?.cashflowChart ?? []).map((row) => ({ value: row.deposits })),
    [data?.cashflowChart],
  );

  if (homeQuery.isError) {
    return (
      <div className="mx-auto max-w-[1600px] pb-4">
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(homeQuery.error)}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (homeQuery.isLoading || !homeQuery.data) return <DashboardSkeleton />;

  const { nome, tipo, tenantNome, totalLeads } = homeQuery.data;

  return (
    <div
      className="mx-auto max-w-[1600px] space-y-4 pb-4 sm:space-y-5"
      aria-busy={summaryQuery.isFetching}
    >
      <HomeHeader
        title={`${greeting}, ${nome}`}
        meta={
          <>
            <Badge variant="secondary">{TIPO_LABEL[tipo]}</Badge>
            <span>{tenantNome}</span>
          </>
        }
        rangeText={period.rangeText}
        isFetching={summaryQuery.isFetching}
        updatedAgo={updatedAgo}
        includesToday={includesToday}
        picker={
          <PeriodPicker preset={period.preset} range={period.range} onChange={period.onChange} />
        }
      />

      {summaryQuery.isLoading ? (
        <DashboardSkeleton />
      ) : !data ? (
        <DashboardError
          message={summaryErrorMessage(summaryQuery.error)}
          onRetry={() => void summaryQuery.refetch()}
        />
      ) : (
        <>
          <HomeKpiCards data={data} sparkline={sparkline} />

          <CashflowCrmRow data={data} />

          <SecondaryMetrics data={data} />

          <LiveFeed events={data.liveEvents} playerLink="expert" />

          <p className="text-xs leading-relaxed text-muted-foreground">
            Só entram os seus leads
            {tipo === "total" ? " (com acesso total, todos os jogadores da casa)" : ""}. Recuperado
            pelo CRM considera depósitos feitos em até 7 dias depois de um clique no link de
            campanha ou jornada, sem quem já estava jogando. Datas no fuso de Brasília.
          </p>
        </>
      )}

      <ParaChamarHojeCard />

      <MeuConsumoCard />

      <div className="flex flex-wrap gap-3 sm:gap-4">
        <HomeCard className="w-fit p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold">Seus leads: {num(totalLeads)}</h2>
          <Button asChild className="mt-3 gap-2">
            <Link to="/expert/leads">
              Ver leads
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </HomeCard>
        <HomeCard className="w-fit max-w-md p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold">Seu rendimento</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Depósitos creditados a você (clique no seu link ou seu ID de afiliado), a base da sua
            comissão.
          </p>
          <Button asChild variant="outline" className="mt-3 gap-2">
            <Link to="/expert/rendimento">
              Ver relatório completo
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </HomeCard>
      </div>
    </div>
  );
}
