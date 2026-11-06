// The two tabs of the Web Push channel page (/webpush) and its "not
// installed yet" state. Campaign rows come from listWebpushCampaignsFn (same
// query key as the campaigns hub); the overview numbers from
// getWebpushChannelOverviewFn.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Plug, Send } from "lucide-react";

import {
  ChannelBlock,
  ChannelOverview,
  ChannelSendsChart,
  useChannelPeriod,
} from "@/components/channels/channel-overview";
import { HomeCard } from "@/components/home/home-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-premium/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tourAnchor } from "@/help/anchor";
import { getChannelOperationState } from "@/lib/channel-operation-state";
import { CHART_COLORS } from "@/lib/chart-theme";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getWebpushChannelOverviewFn } from "@/lib/webpush/channel-overview.functions";
import { listWebpushCampaignsFn } from "@/lib/webpush/campaigns.functions";

const RECENT_CAMPAIGNS = 5;
// listWebpushCampaigns returns at most the 200 most recent campaigns.
const CAMPAIGNS_CAP = 200;

type WebpushCampaignRow = {
  id: string;
  name: string;
  status: string;
  scheduledAt: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
};

function pct(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function useWebpushCampaigns() {
  const listFn = useServerFn(listWebpushCampaignsFn);
  return useQuery({
    queryKey: ["webpush-campaigns"],
    queryFn: () => listFn(),
    refetchInterval: 30_000,
  });
}

function CampaignStatusBadge({ status }: { status: string }) {
  const operation = getChannelOperationState(status, "webpush");
  return (
    <Badge variant="outline" className={cn("shrink-0", operation.tone)}>
      {operation.label}
    </Badge>
  );
}

function ReportLink({ campaignId }: { campaignId: string }) {
  return (
    <Button size="sm" variant="outline" asChild>
      <Link to="/campanhas/$campaignId/relatorio" params={{ campaignId }}>
        Relatório
      </Link>
    </Button>
  );
}

/** Channel on, integration not installed yet: nothing to send to. */
export function WebpushNotInstalledState() {
  return (
    <HomeCard>
      <EmptyState
        icon={<Send aria-hidden="true" />}
        title="Web Push ainda não instalado"
        description="Instale o Web Push no site da casa para coletar inscrições e enviar campanhas de notificação no navegador. A instalação fica em Integrações, na aba Web Push."
        action={
          <Button asChild {...tourAnchor("webpush.nao-instalado.integracoes")}>
            <Link to="/webhooks" hash="webpush">
              <Plug className="size-4" aria-hidden="true" />
              Abrir Integrações
            </Link>
          </Button>
        }
      />
    </HomeCard>
  );
}

/** Visão geral: subscriptions, pushes sent, clicks and refused, plus recent campaigns. */
export function WebpushOverviewTab({ onOpenHistory }: { onOpenHistory: () => void }) {
  const period = useChannelPeriod();
  const { query } = period;
  const overviewFn = useServerFn(getWebpushChannelOverviewFn);
  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["webpush-channel-overview", query.from, query.to],
    queryFn: () => overviewFn({ data: { from: query.from, to: query.to } }),
    refetchInterval: query.includesToday ? 30_000 : false,
    placeholderData: (previous) => previous,
  });
  const campaigns = useWebpushCampaigns();

  const subscriptions = data?.subscriptions;
  const totals = data?.totals;
  const sent = totals?.sent ?? 0;
  const clicks = totals?.clicks ?? 0;
  const recent = ((campaigns.data ?? []) as WebpushCampaignRow[]).slice(0, RECENT_CAMPAIGNS);

  return (
    <ChannelOverview
      period={period}
      updatedAt={dataUpdatedAt}
      isFetching={isFetching}
      isLoading={isLoading}
      kpis={[
        {
          title: "Inscrições ativas",
          value: num(subscriptions?.active ?? 0),
          detail: `${num(subscriptions?.linked ?? 0)} ligadas a jogadores · ${num(subscriptions?.total ?? 0)} no total`,
        },
        { title: "Pushes enviados", value: num(sent), detail: "aceitos pelo OneSignal" },
        {
          title: "Cliques",
          value: num(clicks),
          detail: sent > 0 ? `${pct(clicks, sent)}% dos pushes enviados` : undefined,
        },
        {
          title: "Recusados",
          value: num(totals?.refused ?? 0),
          detail: "o OneSignal não aceitou o envio",
        },
      ]}
      chart={
        <ChannelSendsChart
          historyChannel="webpush"
          period={period}
          daily={data?.by_day}
          hourly={{ points: data?.by_hour }}
          series={[
            { key: "sent", label: "Enviados", color: CHART_COLORS.primary },
            { key: "refused", label: "Recusados", color: CHART_COLORS.danger },
          ]}
        />
      }
    >
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div {...tourAnchor("webpush.campanhas.recentes")}>
          <ChannelBlock
            title="Campanhas recentes"
            description={`As ${RECENT_CAMPAIGNS} últimas campanhas de Web Push.`}
            action={
              <Button size="sm" variant="ghost" onClick={onOpenHistory}>
                Ver todas
              </Button>
            }
          >
            {campaigns.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nenhuma campanha de Web Push ainda.
              </p>
            ) : (
              <ul>
                {recent.map((campaign) => (
                  <li
                    key={campaign.id}
                    className="flex items-center gap-3 border-b border-border/70 py-2.5 text-[13.5px] last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{campaign.name || "Campanha sem nome"}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {formatWhen(campaign.scheduledAt)} · {num(campaign.sentCount)} de{" "}
                        {num(campaign.targetCount)} enviados
                      </p>
                    </div>
                    <CampaignStatusBadge status={campaign.status} />
                    <ReportLink campaignId={campaign.id} />
                  </li>
                ))}
              </ul>
            )}
          </ChannelBlock>
        </div>

        <ChannelBlock
          title="Instalação e permissão"
          description="Script no site, mensagem que pede a permissão e push de teste."
        >
          <p className="text-[13.5px] text-muted-foreground">
            As configurações do Web Push ficam em Integrações, na aba Web Push.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            asChild
            {...tourAnchor("webpush.integracoes.link")}
          >
            <Link to="/webhooks" hash="webpush">
              <Plug className="size-4" aria-hidden="true" />
              Abrir Integrações
            </Link>
          </Button>
        </ChannelBlock>
      </div>
    </ChannelOverview>
  );
}

/** Histórico: every web push campaign (up to the 200 most recent). */
export function WebpushHistoryTab() {
  const campaigns = useWebpushCampaigns();
  const rows = (campaigns.data ?? []) as WebpushCampaignRow[];

  return (
    <div {...tourAnchor("webpush.historico.tabela")}>
      <ChannelBlock
        title="Campanhas de Web Push"
        description={
          rows.length >= CAMPAIGNS_CAP
            ? `As ${CAMPAIGNS_CAP} mais recentes, da mais nova para a mais antiga.`
            : "Da mais nova para a mais antiga."
        }
      >
        {campaigns.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : campaigns.isError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Não foi possível carregar as campanhas. Tente de novo em instantes.
          </p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhuma campanha de Web Push ainda.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campanha</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Agendada para</TableHead>
                  <TableHead className="text-right">Público</TableHead>
                  <TableHead className="text-right">Enviados</TableHead>
                  <TableHead className="text-right">Falhas</TableHead>
                  <TableHead>
                    <span className="sr-only">Relatório</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((campaign) => (
                  <TableRow key={campaign.id}>
                    <TableCell className="max-w-[240px] truncate font-medium">
                      {campaign.name || "Campanha sem nome"}
                    </TableCell>
                    <TableCell>
                      <CampaignStatusBadge status={campaign.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatWhen(campaign.scheduledAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(campaign.targetCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(campaign.sentCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(campaign.failedCount)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ReportLink campaignId={campaign.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ChannelBlock>
    </div>
  );
}
