import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Pencil,
  Plus,
  Users,
} from "lucide-react";
import {
  UNRESOLVED_REASON_HINT,
  UNRESOLVED_REASON_LABEL,
  UNRESOLVED_REASONS,
  type UnresolvedReason,
} from "@/lib/campaign-recipients";
import {
  exportCampaignRecipientsCsv,
  exportCampaignUnresolvedCsv,
  getCampaignReportDetails,
  getConversionDrilldown,
  getConversionDataHealth,
  getConversionReport,
  getJourneyReportDetails,
} from "@/lib/conversion-report.functions";
import { TRIGGER_NAMES, type TriggerType } from "@/lib/triggers";
import { campaignStopReason, getChannelOperationState } from "@/lib/channel-operation-state";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { HomeCard, KpiCard, MetricRow } from "@/components/home/home-cards";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FunnelFilter, type FunnelStage } from "@/components/reports/funnel-filter";
import {
  ConversionList,
  RecipientList,
  TrackedLeadList,
  type ReportRecipient,
} from "@/components/reports/recipient-list";
import {
  CopyMessageButton,
  ReportNotice,
  ReportSectionHeader,
  StatCell,
  TechnicalDetails,
  WindowCaption,
} from "@/components/reports/report-parts";
import { dateTime, day, money, number, percent, ratio } from "@/components/reports/format";
import { cn } from "@/lib/utils";

type RecipientFilter =
  | "all"
  | "sent"
  | "delivered"
  | "clicked"
  | "not-clicked"
  | "registered"
  | "engaged"
  | "first-deposit"
  | "deposited"
  | "clicked-no-deposit";

const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
  whatsapp: "WhatsApp",
};
const JOURNEY_STATUS_LABEL: Record<string, string> = {
  active: "Ativa",
  paused: "Pausada",
  draft: "Rascunho",
  archived: "Arquivada",
};
const STEP_TYPE_LABEL: Record<string, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
  whatsapp: "WhatsApp",
  wait: "Espera",
};
const ptLabel = (map: Record<string, string>, value?: string | null) =>
  value ? (map[value.toLowerCase()] ?? value) : "—";

/** The single way out of a report: back to the list it was opened from. */
function BackLink({ sourceType }: { sourceType: "campaign" | "journey" }) {
  return (
    <Button variant="outline" size="sm" asChild>
      {sourceType === "campaign" ? (
        <Link to="/campanhas">Voltar para Campanhas</Link>
      ) : (
        <Link to="/automacoes">Voltar para Automações</Link>
      )}
    </Button>
  );
}

export function ConversionReport({
  sourceType,
  sourceId,
}: {
  sourceType: "campaign" | "journey";
  sourceId: string;
}) {
  const [loadJourneyDrilldown, setLoadJourneyDrilldown] = useState(false);
  const campaignDetails = useQuery({
    queryKey: ["campaign-report-details", sourceId],
    queryFn: () => getCampaignReportDetails({ data: { campaignId: sourceId, limit: 500 } }),
    enabled: sourceType === "campaign",
    retry: false,
  });
  const journeyDetails = useQuery({
    queryKey: ["journey-report-details", sourceId],
    queryFn: () => getJourneyReportDetails({ data: { journeyId: sourceId } }),
    enabled: sourceType === "journey",
    retry: false,
  });
  const isVoice = campaignDetails.data?.campaign?.channel === "voice";
  const conversionEnabled =
    sourceType === "journey" ||
    (sourceType === "campaign" && campaignDetails.isSuccess && !isVoice);
  const query = useQuery({
    queryKey: ["conversion-report", sourceType, sourceId],
    queryFn: () => getConversionReport({ data: { sourceType, sourceId } }),
    enabled: conversionEnabled,
    retry: false,
  });
  const health = useQuery({
    queryKey: ["conversion-data-health", sourceType, sourceId],
    queryFn: () => getConversionDataHealth({ data: { sourceType, sourceId } }),
    enabled: conversionEnabled && query.isSuccess && journeyDetails.isSuccess,
    retry: false,
  });
  const drilldown = useQuery({
    queryKey: ["conversion-drilldown", sourceType, sourceId],
    queryFn: () => getConversionDrilldown({ data: { sourceType, sourceId, limit: 200 } }),
    enabled:
      sourceType === "journey" &&
      conversionEnabled &&
      loadJourneyDrilldown &&
      query.isSuccess &&
      journeyDetails.isSuccess,
    retry: false,
  });

  if (
    (sourceType === "campaign" && campaignDetails.isLoading) ||
    (sourceType === "journey" && journeyDetails.isLoading) ||
    (!isVoice && conversionEnabled && query.isLoading)
  )
    return <ReportState sourceType={sourceType}>Carregando relatório…</ReportState>;
  if (sourceType === "campaign" && campaignDetails.isError)
    return (
      <ReportState sourceType={sourceType}>Não foi possível carregar o relatório.</ReportState>
    );
  if (sourceType === "journey" && journeyDetails.isError)
    return (
      <ReportState sourceType={sourceType}>Não foi possível carregar o relatório.</ReportState>
    );

  if (sourceType === "campaign" && isVoice && campaignDetails.data)
    return <VoiceCampaignReport details={campaignDetails.data} />;

  if (query.isError || !query.data)
    return (
      <ReportState sourceType={sourceType}>Não foi possível carregar o relatório.</ReportState>
    );

  // The integration-wide health indicator (`globalAttributionHealth`) is not
  // about this campaign or journey: it belongs to Integrações, not here (D-34).
  if (sourceType === "journey")
    return (
      <JourneyReport
        journeyId={sourceId}
        data={query.data}
        details={journeyDetails.data}
        drilldown={drilldown.data}
        drilldownLoading={drilldown.isFetching}
        onLoadDrilldown={() => setLoadJourneyDrilldown(true)}
        alerts={health.data?.alerts ?? []}
      />
    );

  return (
    <CampaignReport
      sourceId={sourceId}
      data={query.data}
      details={campaignDetails.data}
      detailsError={campaignDetails.isError}
      alerts={health.data?.alerts ?? []}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Voice campaign                                                      */
/* ------------------------------------------------------------------ */

function VoiceCampaignReport({
  details,
}: {
  details: Awaited<ReturnType<typeof getCampaignReportDetails>>;
}) {
  const campaign = details.campaign;
  const voice = details.voice;
  if (!campaign || campaign.channel !== "voice" || !voice)
    return (
      <ReportState sourceType="campaign">Não foi possível carregar o relatório de voz.</ReportState>
    );

  const status = voiceStatusLabel(voice.queueStatus, voice.providerStatus);
  const answeredLabel = voice.answered
    ? "Sim"
    : ["completed", "failed", "cancelled"].includes(voice.queueStatus)
      ? "Não"
      : "Aguardando";

  return (
    <Page>
      <PageHeader
        title={campaign.name}
        subtitle={campaignSubtitle(campaign)}
        actions={<BackLink sourceType="campaign" />}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard title="Status" value={status} />
        <KpiCard title="Atendida" value={answeredLabel} />
        <KpiCard
          title="Tempo de chamada"
          value={formatCallDuration(voice.durationSeconds)}
          detail={voice.durationSeconds === null ? "não informado pelo provedor" : undefined}
        />
        <KpiCard
          title="Tentativas"
          value={number(Math.max(voice.attempts, voice.attemptedAt ? 1 : 0))}
        />
      </div>

      {voice.error ? (
        <HomeCard className="border-danger/30 p-4 sm:p-5">
          <p className="text-label text-danger">Motivo da falha</p>
          <p className="mt-1 text-body font-semibold">{voice.error}</p>
        </HomeCard>
      ) : null}

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader title="Resultado da ligação" className="mb-2" />
          <MetricRow label="Destinatário" value={voice.playerName ?? "Não identificado"} />
          <MetricRow label="Telefone" value={voice.phone ?? "Não informado"} />
          <MetricRow label="Resultado" value={voiceResultLabel(voice.result)} />
          <MetricRow label="Criada em" value={dateTime(campaign.createdAt)} />
          <MetricRow label="Agendada para" value={dateTime(campaign.scheduledAt)} />
          <MetricRow label="Ligação iniciada" value={dateTime(voice.attemptedAt)} />
          <div className="mt-3">
            <TechnicalDetails>
              <div className="rounded-lg border border-border/70 px-3">
                <MetricRow label="Provedor de voz" value={voice.provider ?? "Infobip"} />
                <MetricRow label="Status no provedor" value={voice.providerStatus ?? "—"} />
                <MetricRow
                  label="Código HTTP do provedor"
                  value={voice.providerStatusCode === null ? "—" : String(voice.providerStatusCode)}
                />
                <MetricRow
                  label="Identificador no provedor"
                  value={
                    voice.providerCallId ? (
                      <span className="break-all font-mono text-meta">{voice.providerCallId}</span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            </TechnicalDetails>
          </div>
        </HomeCard>

        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader title="Conteúdo da ligação" className="mb-3" />
          <p className="whitespace-pre-wrap text-body">
            {campaign.content ?? "O conteúdo original não está disponível para esta ligação."}
          </p>
        </HomeCard>
      </div>
    </Page>
  );
}

function campaignSubtitle(campaign: {
  channel?: string | null;
  scheduledAt?: string | null;
  createdAt?: string | null;
}) {
  const parts = ["Relatório da campanha"];
  if (campaign.channel) parts.push(ptLabel(CHANNEL_LABEL, campaign.channel));
  const when = day(campaign.scheduledAt) ?? day(campaign.createdAt);
  if (when) parts.push(when);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* SMS / e-mail campaign                                               */
/* ------------------------------------------------------------------ */

function CampaignReport({
  sourceId,
  data,
  details,
  detailsError,
  alerts,
}: {
  sourceId: string;
  data: Awaited<ReturnType<typeof getConversionReport>>;
  details: Awaited<ReturnType<typeof getCampaignReportDetails>> | undefined;
  detailsError: boolean;
  alerts: Array<{ code: string; message: string }>;
}) {
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const campaign = details?.campaign;
  const recipients = useMemo(
    () => (details?.recipients ?? []) as ReportRecipient[],
    [details?.recipients],
  );
  // Every count comes from the whole campaign (server). `recipients` holds only
  // the first rows of the list and must never feed a total or a rate.
  const delivered = data.delivered ?? 0;
  const clicked = data.clicked ?? 0;
  const depositors = data.depositors;
  const activeDepositors = data.activeDepositors ?? 0;
  // Without delivery receipts the click rate falls back to the sent messages.
  const reached = delivered || data.sent;
  // SMS and email providers do not confirm delivery; only voice has a real outcome.
  const showDelivered =
    campaign?.channel !== "sms" && campaign?.channel !== "email" && data.delivered !== null;
  const notClicked = Math.max(0, reached - clicked);
  const clickedNoDeposit = Math.max(0, clicked - depositors - activeDepositors);
  const audience = campaign?.total || campaign?.audience || details?.trackedDeliveries || data.sent;
  const listIsPartial = Boolean(details && audience > details.recipientsShown);
  const filtered = useMemo(
    () =>
      recipients.filter((row) => {
        if (filter === "sent") return row.sendStatus === "sent";
        if (filter === "delivered") return row.deliveryStatus === "delivered";
        if (filter === "clicked") return row.clicked;
        if (filter === "not-clicked") return !row.clicked;
        if (filter === "registered") return Boolean(row.registeredAt);
        if (filter === "engaged") return Boolean(row.loginOrGameAt);
        if (filter === "first-deposit") return Boolean(row.firstDepositAt);
        if (filter === "deposited") return Boolean(row.depositAt);
        if (filter === "clicked-no-deposit")
          return row.clicked && !row.depositAt && !row.activeDepositAt;
        return true;
      }),
    [filter, recipients],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const failureReasons = Object.entries(details?.failureReasons ?? {}).sort((a, b) => b[1] - a[1]);
  const directRevenue = data.revenue;
  const revenuePerPlayer = depositors ? directRevenue / depositors : 0;
  const smsCost = data.smsCost ?? null;
  const isEmail = campaign?.channel === "email";
  const stopReason = campaign
    ? campaignStopReason(campaign.status, campaign.lastError, campaign.finishedAt)
    : null;
  const attributedPlayers = `${number(depositors)} ${
    depositors === 1 ? "jogador atribuído" : "jogadores atribuídos"
  }`;

  // The whole funnel, once: each stage with its whole-campaign number. It is
  // also the filter of the list below (D-30, E-28).
  const stages: FunnelStage<RecipientFilter>[] = [
    { value: "all", label: "Público", count: audience },
    { value: "sent", label: "Enviados", count: data.sent },
    ...(showDelivered
      ? [{ value: "delivered" as const, label: "Entregues", count: delivered }]
      : []),
    { value: "clicked", label: "Clicaram", count: data.clicked === null ? null : clicked },
    { value: "not-clicked", label: "Não clicaram", count: notClicked },
    { value: "registered", label: "Cadastros", count: data.registered },
    { value: "engaged", label: "Login ou jogo", count: data.loginOrGame },
    { value: "first-deposit", label: "Primeiro depósito", count: data.ftd, tone: "success" },
    { value: "deposited", label: "Depositaram", count: depositors, tone: "success" },
    {
      value: "clicked-no-deposit",
      label: "Clicaram e não depositaram",
      count: clickedNoDeposit,
      tone: "warning",
    },
  ];
  const stageTotal = stages.find((stage) => stage.value === filter)?.count ?? null;
  const firstRow = filtered.length ? (page - 1) * pageSize + 1 : 0;
  const lastRow = Math.min(page * pageSize, filtered.length);

  const setActiveFilter = (next: RecipientFilter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <Page>
      <PageHeader
        title={campaign?.name ?? "Relatório da campanha"}
        subtitle={campaign ? campaignSubtitle(campaign) : "Relatório da campanha"}
        actions={<BackLink sourceType="campaign" />}
      />

      {stopReason && campaign ? (
        <ReportNotice>
          <p className="font-semibold text-foreground">
            {getChannelOperationState(campaign.status, campaign.channel).label}
          </p>
          <p className="mt-0.5">{stopReason}</p>
        </ReportNotice>
      ) : null}

      {alerts.map((alert) => (
        <ReportNotice key={alert.code} tone="warning">
          {alert.message}
        </ReportNotice>
      ))}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard title="Enviados" value={number(data.sent)} />
        <KpiCard
          title="Clicaram"
          value={data.clicked === null ? "—" : number(clicked)}
          detail={
            reached
              ? `${percent(clicked, reached)} ${delivered ? "de quem recebeu" : "dos enviados"}`
              : undefined
          }
        />
        <KpiCard
          title="Depositaram"
          value={number(depositors)}
          detail={clicked ? `${percent(depositors, clicked)} de quem clicou` : undefined}
        />
        <KpiCard
          title="Recuperado pelo CRM"
          value={money(directRevenue)}
          detail="total desde o disparo"
        />
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader
            title="Custo e retorno"
            description="Total da campanha desde o disparo, pelo último clique em até 7 dias"
            className="mb-2"
          />
          <MetricRow
            label="Receita média por jogador que voltou"
            value={depositors ? money(revenuePerPlayer) : "—"}
          />
          <MetricRow
            label={isEmail ? "Consumo de e-mail" : "Custo em SMS"}
            value={smsCost === null ? `${number(data.sent)} envios` : money(smsCost)}
          />
          <MetricRow label="Retorno" value={smsCost ? `${ratio(directRevenue / smsCost)}x` : "—"} />
          {data.assistedRevenue > 0 ? (
            <MetricRow
              label="Receita assistida (fora do total)"
              value={money(data.assistedRevenue)}
            />
          ) : null}
          <div className="mt-2 space-y-1 text-meta text-muted-foreground">
            <p>
              {smsCost === null
                ? "Custo financeiro indisponível para este canal."
                : `Custo: ${number(data.sent)} envios × ${money(data.smsPrice ?? 0)}. Retorno = recuperado ÷ custo.`}{" "}
              Recuperado de {attributedPlayers}.
            </p>
            <ActiveNote players={data.activeDepositors} revenue={data.activeRevenue} />
          </div>
        </HomeCard>

        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader title="Disparo" className="mb-2" />
          <MetricRow label="Criada em" value={dateTime(campaign?.createdAt)} />
          <MetricRow label="Disparo iniciado" value={dateTime(campaign?.scheduledAt)} />
          <MetricRow label="Disparo concluído" value={dateTime(campaign?.finishedAt)} />
          <MetricRow label="Repetidos ignorados" value={number(data.deduplicated)} />
          <MetricRow label="Prazo para contar o depósito" value="até 7 dias após o clique" />
          <p className="mt-2 text-meta text-muted-foreground">
            Cada jogador recebe um link próprio: o clique conta quando ele abre o link da mensagem.
            Contatos repetidos no público recebem uma mensagem só.
          </p>
        </HomeCard>
      </div>

      {campaign?.failed || failureReasons.length > 0 ? (
        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader
            title="Por que não saiu"
            description={
              failureReasons.length
                ? "Envios que o provedor não aceitou ou não concluiu"
                : "O provedor não retornou um motivo individual para estes destinatários"
            }
            className="mb-2"
          />
          <ul className="divide-y divide-border/70">
            {failureReasons.length ? (
              failureReasons.slice(0, 4).map(([reason, count]) => (
                <li key={reason} className="flex items-baseline gap-3 py-2.5 text-body">
                  <span className="w-14 shrink-0 text-right font-semibold tabular-nums">
                    {number(count)}
                  </span>
                  <span className="min-w-0 break-words text-muted-foreground">{reason}</span>
                </li>
              ))
            ) : (
              <li className="flex items-baseline gap-3 py-2.5 text-body">
                <span className="w-14 shrink-0 text-right font-semibold tabular-nums">
                  {number(campaign?.failed ?? 0)}
                </span>
                <span className="text-muted-foreground">Não enviados</span>
              </li>
            )}
          </ul>
        </HomeCard>
      ) : null}

      {details?.unresolved && details.unresolved.total > 0 ? (
        <UnresolvedRecipientsCard
          sourceId={sourceId}
          unresolved={details.unresolved}
          canExport={Boolean(data.canViewSensitive)}
        />
      ) : null}

      <HomeCard className="p-4 sm:p-5">
        <ReportSectionHeader
          title="A mensagem que foi enviada"
          actions={
            <>
              <CopyMessageButton text={campaign?.content} />
              <Button size="sm" variant="ghost" asChild>
                <Link to="/campanhas" search={{ newCampaign: 1 } as never}>
                  <Plus className="mr-1.5 size-4" aria-hidden="true" />
                  Nova campanha
                </Link>
              </Button>
            </>
          }
          className="mb-3"
        />
        <p className="whitespace-pre-wrap break-words text-body">
          {campaign?.content ?? "O conteúdo original não está disponível para esta campanha."}
        </p>
        <p className="mt-3 text-meta text-muted-foreground">
          Para reaproveitar, copie o texto e cole numa nova campanha; esta campanha não muda. Os
          links saíram trocados por links próprios de cada jogador, para contar os cliques.
        </p>
      </HomeCard>

      <HomeCard className="p-4 sm:p-5">
        <ReportSectionHeader
          title="Funil e destinatários"
          description="Escolha uma etapa para ver quem chegou nela"
          actions={
            <Button
              size="sm"
              variant="ghost"
              disabled={!data.canViewSensitive}
              title={
                data.canViewSensitive ? undefined : "Disponível para administradores da operação"
              }
              onClick={() => void downloadRecipients(sourceId)}
            >
              <Download className="mr-1.5 size-4" aria-hidden="true" /> Baixar CSV
            </Button>
          }
          className="mb-3"
        />
        <FunnelFilter stages={stages} value={filter} onValueChange={setActiveFilter} />

        {detailsError ? (
          <p className="mt-4 text-body text-muted-foreground">
            Os totais estão disponíveis, mas não foi possível carregar a lista individual.
          </p>
        ) : recipients.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="Sem destinatários individuais"
            description="Esta campanha não possui destinatários rastreáveis individualmente."
          />
        ) : (
          <>
            <p className="mt-3 text-meta text-muted-foreground">
              {stageTotal !== null && filtered.length < stageTotal
                ? `Mostrando ${number(filtered.length)} de ${number(stageTotal)}`
                : `${number(filtered.length)} ${filtered.length === 1 ? "destinatário" : "destinatários"}`}
              {listIsPartial && details
                ? ` — a lista carrega só os primeiros ${number(details.recipientsShown)} destinatários da campanha; o CSV traz todos.`
                : null}
            </p>
            {filtered.length === 0 ? (
              <EmptyState
                title="Ninguém nesta etapa na lista"
                description={
                  listIsPartial
                    ? "Ninguém entre os destinatários carregados chegou aqui. Baixe o CSV para ver a campanha inteira."
                    : "Nenhum destinatário chegou a esta etapa."
                }
              />
            ) : (
              <>
                <div className="mt-2">
                  <RecipientList rows={visible} showDelivered={showDelivered} />
                </div>
                {pages > 1 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 text-meta text-muted-foreground">
                    <span className="tabular-nums">
                      {number(firstRow)}–{number(lastRow)} de {number(filtered.length)} · página{" "}
                      {page} de {pages}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={page === 1}
                        onClick={() => setPage((value) => value - 1)}
                      >
                        <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
                        Anterior
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={page === pages}
                        onClick={() => setPage((value) => value + 1)}
                      >
                        Próxima
                        <ChevronRight className="ml-1 size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </HomeCard>

      {recipients.some((row) => row.depositAt) ? (
        <HomeCard className="p-4 sm:p-5">
          <ReportSectionHeader
            title="Quem clicou e depositou"
            description="Só entra quem tem vínculo com o próprio clique; depósitos sem esse vínculo não inflam o resultado"
            className="mb-2"
          />
          <ConversionList rows={recipients.filter((row) => row.depositAt)} />
        </HomeCard>
      ) : null}
    </Page>
  );
}

type CampaignUnresolved = NonNullable<
  Awaited<ReturnType<typeof getCampaignReportDetails>>["unresolved"]
>;

/** ENV-06 — recipients that the campaign skipped, with the reason. */
function UnresolvedRecipientsCard({
  sourceId,
  unresolved,
  canExport,
}: {
  sourceId: string;
  unresolved: CampaignUnresolved;
  canExport: boolean;
}) {
  const [exporting, setExporting] = useState(false);
  const reasons = UNRESOLVED_REASONS.filter((reason) => unresolved.byReason[reason] > 0);
  return (
    <HomeCard className="p-4 sm:p-5">
      <section aria-labelledby="unresolved-recipients-title">
        <ReportSectionHeader
          id="unresolved-recipients-title"
          title={
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
              Não enviados ({number(unresolved.total)})
            </span>
          }
          description="Estes destinatários ficaram fora da campanha; os demais receberam normalmente"
          actions={
            <Button
              size="sm"
              variant="ghost"
              disabled={!canExport || exporting}
              title={canExport ? undefined : "Disponível para administradores da operação"}
              onClick={async () => {
                setExporting(true);
                try {
                  await downloadUnresolved(sourceId);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download className="mr-1.5 size-4" aria-hidden="true" />
              {exporting ? "Gerando…" : "Baixar CSV"}
            </Button>
          }
          className="mb-2"
        />
        <ul className="divide-y divide-border/70">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-baseline gap-3 py-2.5">
              <span className="w-14 shrink-0 text-right text-body font-semibold tabular-nums text-warning">
                {number(unresolved.byReason[reason])}
              </span>
              <div className="min-w-0">
                <p className="text-body font-medium">{UNRESOLVED_REASON_LABEL[reason]}</p>
                <p className="text-meta text-muted-foreground">{UNRESOLVED_REASON_HINT[reason]}</p>
              </div>
            </li>
          ))}
        </ul>
        {unresolved.sample.length > 0 ? (
          <details className="mt-3 text-meta">
            <summary className="cursor-pointer text-label text-muted-foreground hover:text-foreground">
              Ver os primeiros {number(unresolved.sample.length)}
            </summary>
            <ul className="mt-2 grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
              {unresolved.sample.map((row, index) => (
                <li
                  key={`${row.phone}-${row.reason}-${index}`}
                  className="flex justify-between gap-2 border-b border-border/50 py-1.5"
                >
                  <span className="font-mono tabular-nums">{row.phone}</span>
                  <span className="text-muted-foreground">
                    {UNRESOLVED_REASON_LABEL[row.reason as UnresolvedReason] ?? row.reason}
                  </span>
                </li>
              ))}
            </ul>
            {unresolved.total > unresolved.sample.length ? (
              <p className="mt-2 text-muted-foreground">
                O CSV traz a lista completa, com o telefone sem máscara.
              </p>
            ) : null}
          </details>
        ) : null}
      </section>
    </HomeCard>
  );
}

/** Click deposits of players already active: reported apart, never in the totals. */
function ActiveNote({ players, revenue }: { players?: number; revenue?: number }) {
  if (!players) return null;
  return (
    <p className="text-meta text-muted-foreground">
      Fora da conta: {number(players)} {players === 1 ? "jogador já ativo" : "jogadores já ativos"}{" "}
      (depositaram nas 48 h antes do clique) somaram {money(revenue ?? 0)} depois de clicar.
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Journey                                                             */
/* ------------------------------------------------------------------ */

function JourneyReport({
  journeyId,
  data,
  details,
  drilldown,
  drilldownLoading,
  onLoadDrilldown,
  alerts,
}: {
  journeyId: string;
  data: Awaited<ReturnType<typeof getConversionReport>>;
  details: Awaited<ReturnType<typeof getJourneyReportDetails>> | undefined;
  drilldown: Awaited<ReturnType<typeof getConversionDrilldown>> | undefined;
  drilldownLoading: boolean;
  onLoadDrilldown: () => void;
  alerts: Array<{ code: string; message: string }>;
}) {
  const journey = details?.journey;
  const allSteps: any[] = details?.steps ?? [];
  const actionableSteps = allSteps.filter((step) => !["wait", "end"].includes(step.step_type));
  const stepRows = actionableSteps.map((step) => {
    const conversion = data.byStep.find((row) => row.stepId === step.id);
    const waitSeconds = allSteps
      .filter((candidate) => candidate.step_type === "wait" && candidate.position < step.position)
      .filter(
        (candidate) =>
          !allSteps.some(
            (between) =>
              !["wait", "end"].includes(between.step_type) &&
              between.position > candidate.position &&
              between.position < step.position,
          ),
      )
      .reduce((sum, candidate) => sum + Number((candidate.config as any)?.delay_seconds ?? 0), 0);
    return {
      ...step,
      waitSeconds,
      current: Number(step.current ?? 0),
      delivered: Number(conversion?.delivered ?? 0),
      clicked: Number(conversion?.clicked ?? 0),
      deposits: Number(conversion?.deposits ?? 0),
      recovered: Number(conversion?.recovered ?? 0),
      variants: conversion?.variants ?? [],
      withoutVariant: conversion?.withoutVariant,
      copies: data.stepCopies?.[step.id] ?? [],
    };
  });
  const retiredSteps = data.retiredSteps ?? [];
  const rotatesCopies = stepRows.some((step) => step.copies.length > 1);
  const sent7d = stepRows.reduce((sum, step) => sum + Number(step.sent7d ?? 0), 0);
  const failed = stepRows.reduce((sum, step) => sum + Number(step.failed ?? 0), 0);
  // Keep the headline consistent with the stages: only direct, tracked
  // attributions are revenue recovered by this journey. `journey_metrics`
  // is operational state and can include a player's unrelated balance.
  const recovered = Number(data.revenue ?? 0);
  const deposits = Number(data.deposits ?? 0);
  const unassigned = data.unassignedStep ?? { deposits: 0, recovered: 0 };
  const triggerName = journey?.trigger_type
    ? (TRIGGER_NAMES[journey.trigger_type as TriggerType] ?? journey.trigger_type)
    : "Não informado";
  const subtitle = [
    "Relatório da jornada",
    journey?.status ? ptLabel(JOURNEY_STATUS_LABEL, journey.status) : null,
    `Evento: ${triggerName}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page>
      <PageHeader
        title={journey?.name ?? "Relatório da jornada"}
        subtitle={subtitle}
        actions={
          <>
            {journeyId ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/jornadas/$journeyId" params={{ journeyId }}>
                  <Pencil className="mr-1.5 size-4" aria-hidden="true" />
                  Editar jornada
                </Link>
              </Button>
            ) : null}
            <BackLink sourceType="journey" />
          </>
        }
      />
      {journey?.description ? (
        <p className="-mt-2 max-w-3xl text-body text-muted-foreground">{journey.description}</p>
      ) : null}

      {alerts.map((alert) => (
        <ReportNotice key={alert.code} tone="warning">
          {alert.message}
        </ReportNotice>
      ))}
      {sent7d > 0 && data.trackedSent === 0 ? (
        <ReportNotice tone="warning">
          Esta jornada enviou mensagens, mas nenhuma tinha link medido. Por isso cliques, depósitos
          e recuperado ficam em zero; não é falha de sincronização.
        </ReportNotice>
      ) : null}
      {data.observedClicked && data.observedClicked > (data.clicked ?? 0) ? (
        <ReportNotice>
          O encurtador de links registrou {number(data.observedClicked)}{" "}
          {data.observedClicked === 1 ? "clique" : "cliques"}, mas só {number(data.clicked ?? 0)}{" "}
          {(data.clicked ?? 0) === 1 ? "foi confirmado" : "foram confirmados"} pelo nosso link. Os
          não confirmados não entram no resultado.
        </ReportNotice>
      ) : null}
      {data.truncated || details?.metrics?.truncated ? (
        <p className="text-meta text-muted-foreground">
          Volume muito alto: alguns números abaixo consideram apenas os primeiros 100 mil registros.
        </p>
      ) : null}

      <section className="space-y-3" aria-labelledby="journey-total-title">
        <ReportSectionHeader
          id="journey-total-title"
          title="Desde a criação"
          description="Resultado acumulado, pelo último clique em até 7 dias. Inclui etapas hoje desativadas."
        />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <KpiCard title="Enviados com link medido" value={number(data.trackedSent)} />
          <KpiCard title="Clicaram" value={data.clicked === null ? "—" : number(data.clicked)} />
          <KpiCard title="Depósitos atribuídos" value={number(deposits)} />
          <KpiCard title="Recuperado pelo CRM" value={money(recovered)} />
        </div>
        <ActiveNote players={data.activeDepositors} revenue={data.activeRevenue} />
      </section>

      <HomeCard className="p-4 sm:p-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <WindowCaption>Agora</WindowCaption>
            <MetricRow
              label="Em andamento na jornada"
              value={number(details?.metrics?.inProgress ?? 0)}
            />
          </div>
          <div>
            <WindowCaption>Últimos 7 dias</WindowCaption>
            <MetricRow
              label="Entraram na jornada"
              value={number(details?.metrics?.entered7d ?? 0)}
            />
            <MetricRow label="Mensagens enviadas" value={number(sent7d)} />
          </div>
        </div>
      </HomeCard>

      <HomeCard>
        <div className="border-b border-border/70 px-4 py-3 sm:px-5">
          <ReportSectionHeader
            title={rotatesCopies ? "Etapas e mensagens" : "Etapas"}
            description="Envios vêm da execução da jornada; cliques, depósitos e recuperado usam o link medido de cada etapa."
          />
        </div>
        {stepRows.length ? (
          <TooltipProvider delayDuration={150}>
            <div className="divide-y divide-border/70">
              {stepRows.map((step, index) => {
                const confirmsDelivery = step.step_type !== "sms" && step.step_type !== "email";
                return (
                  <div key={step.id} className="space-y-3 p-4 sm:px-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="grid size-6 place-items-center rounded-full bg-secondary text-meta font-semibold">
                        {index + 1}
                      </span>
                      <span className="rounded-md bg-secondary px-2 py-0.5 text-meta font-medium text-muted-foreground">
                        {ptLabel(STEP_TYPE_LABEL, step.step_type)}
                      </span>
                      <strong className="text-body font-semibold">
                        {step.label || `Etapa ${index + 1}`}
                      </strong>
                      <span className="flex items-center gap-1 text-meta text-muted-foreground">
                        <Clock className="size-3.5" aria-hidden="true" />
                        {formatJourneyDelay(step.waitSeconds)}
                      </span>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
                      <div className="space-y-1.5">
                        <WindowCaption>Agora e últimos 7 dias</WindowCaption>
                        <div className="grid grid-cols-2 gap-3">
                          <StatCell
                            label="Nesta etapa agora"
                            value={number(step.current)}
                            hint="Jogadores que já entraram e aguardam o envio ou o próximo passo desta etapa"
                          />
                          <StatCell
                            label="Enviados em 7 dias"
                            value={number(Number(step.sent7d ?? 0))}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <WindowCaption>Desde a criação</WindowCaption>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                          <StatCell label="Enviados" value={number(Number(step.sent ?? 0))} />
                          {confirmsDelivery ? (
                            <StatCell label="Entregues" value={number(step.delivered)} />
                          ) : null}
                          <StatCell label="Clicaram" value={number(step.clicked)} />
                          <StatCell label="Depósitos atribuídos" value={number(step.deposits)} />
                          <StatCell
                            label="Recuperado pelo CRM"
                            value={money(step.recovered)}
                            tone="success"
                          />
                        </div>
                      </div>
                    </div>
                    {step.copies.length > 1 || step.variants.length ? (
                      <JourneyCopyTable
                        copies={step.copies}
                        variants={step.variants}
                        withoutVariant={step.withoutVariant}
                      />
                    ) : null}
                  </div>
                );
              })}
              {retiredSteps.length ? (
                <div className="space-y-2 p-4 sm:px-5">
                  <ReportSectionHeader
                    title="Etapas desativadas"
                    description="Enviaram mensagens e depois foram desligadas. O resultado delas continua no total desde a criação."
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-body">
                      <thead className="text-label text-muted-foreground">
                        <tr className="text-left">
                          <th className="py-2 pr-3 font-medium">Etapa</th>
                          <th className="py-2 pr-3 text-right font-medium">Enviados</th>
                          <th className="py-2 pr-3 text-right font-medium">Clicaram</th>
                          <th className="py-2 pr-3 text-right font-medium">Depósitos</th>
                          <th className="py-2 text-right font-medium">Recuperado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50 tabular-nums">
                        {retiredSteps.map((step) => (
                          <tr key={step.stepId} className="text-muted-foreground">
                            <td className="py-2 pr-3">
                              {step.label || `Etapa na posição ${step.stepPosition}`}
                            </td>
                            <td className="py-2 pr-3 text-right">{number(step.sent)}</td>
                            <td className="py-2 pr-3 text-right">{number(step.clicked)}</td>
                            <td className="py-2 pr-3 text-right">{number(step.deposits)}</td>
                            <td className="py-2 text-right">{money(step.recovered)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
              {unassigned.deposits > 0 ? (
                <p className="px-4 py-3 text-meta text-muted-foreground sm:px-5">
                  Sem etapa identificada: {number(unassigned.deposits)}{" "}
                  {unassigned.deposits === 1 ? "depósito" : "depósitos"} ·{" "}
                  {money(unassigned.recovered)} — o envio de origem não corresponde a nenhuma etapa
                  da jornada.
                </p>
              ) : null}
              {failed ? (
                <p className="px-4 py-3 text-meta text-warning sm:px-5">
                  {number(failed)}{" "}
                  {failed === 1
                    ? "envio falhou ou foi cancelado"
                    : "envios falharam ou foram cancelados"}{" "}
                  nas etapas acima, desde a criação.
                </p>
              ) : null}
            </div>
          </TooltipProvider>
        ) : (
          <EmptyState
            title="Sem etapas de comunicação"
            description="Esta jornada ainda não possui etapas de comunicação configuradas."
          />
        )}
      </HomeCard>

      <HomeCard>
        <div className="border-b border-border/70 px-4 py-3 sm:px-5">
          <ReportSectionHeader
            title="Jogadores que receberam"
            description="Clique, login e depósito só aparecem quando pertencem ao mesmo envio medido."
          />
        </div>
        {!drilldown ? (
          <div className="p-4 sm:px-5">
            <p className="text-body text-muted-foreground">
              A lista individual carrega sob demanda, para não atrasar o relatório.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={drilldownLoading}
              onClick={onLoadDrilldown}
            >
              {drilldownLoading ? "Carregando…" : "Carregar jogadores"}
            </Button>
          </div>
        ) : drilldown.rows.length === 0 ? (
          <EmptyState
            title="Sem envios medidos"
            description="Ainda não há envios com link medido nesta jornada."
          />
        ) : (
          <TrackedLeadList rows={drilldown.rows} />
        )}
      </HomeCard>
    </Page>
  );
}

function JourneyCopyTable({
  copies,
  variants,
  withoutVariant,
}: {
  copies: string[];
  variants: Array<{
    variant: number;
    sent: number;
    clicked: number;
    deposits: number;
    recovered: number;
  }>;
  withoutVariant?: { sent: number; clicked: number; deposits: number; recovered: number };
}) {
  const byIndex = new Map(variants.map((row) => [row.variant, row]));
  const indexes = [
    ...new Set([...copies.map((_, index) => index), ...variants.map((row) => row.variant)]),
  ].sort((a, b) => a - b);
  const empty = { sent: 0, clicked: 0, deposits: 0, recovered: 0 };
  const rows = indexes.map((index) => ({
    key: String(index),
    name: `Mensagem ${index + 1}`,
    text: copies[index] ?? "Mensagem removida",
    ...(byIndex.get(index) ?? empty),
  }));
  if (withoutVariant && (withoutVariant.sent > 0 || withoutVariant.deposits > 0))
    rows.push({
      key: "none",
      name: "Sem mensagem registrada",
      text: "Envios anteriores à rotação de mensagens",
      ...withoutVariant,
    });
  const rate = (row: { sent: number; clicked: number }) =>
    row.sent ? `${((row.clicked / row.sent) * 100).toFixed(1).replace(".", ",")}%` : "—";
  return (
    <div className="overflow-x-auto rounded-lg border border-border/70">
      <table className="w-full min-w-[640px] text-body">
        <thead className="border-b border-border/70 text-label text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">Mensagem (rotação)</th>
            <th className="px-3 py-2 text-right font-medium">Enviados</th>
            <th className="px-3 py-2 text-right font-medium">Clicaram</th>
            <th className="px-3 py-2 text-right font-medium">Taxa de clique</th>
            <th className="px-3 py-2 text-right font-medium">Depósitos</th>
            <th className="px-3 py-2 text-right font-medium">Recuperado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50 tabular-nums">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="max-w-[320px] px-3 py-2">
                <div className="font-medium">{row.name}</div>
                <div className="truncate text-meta text-muted-foreground" title={row.text}>
                  {row.text}
                </div>
              </td>
              <td className="px-3 py-2 text-right">{number(row.sent)}</td>
              <td className="px-3 py-2 text-right">{number(row.clicked)}</td>
              <td className="px-3 py-2 text-right">{rate(row)}</td>
              <td className="px-3 py-2 text-right">{number(row.deposits)}</td>
              <td className="px-3 py-2 text-right font-semibold text-success">
                {money(row.recovered)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

function ReportState({
  sourceType,
  children,
}: {
  sourceType: "campaign" | "journey";
  children: ReactNode;
}) {
  return (
    <Page>
      <PageHeader actions={<BackLink sourceType={sourceType} />} />
      <HomeCard className={cn("grid place-items-center p-10 text-body text-muted-foreground")}>
        <div role="status">{children}</div>
      </HomeCard>
    </Page>
  );
}

function formatCallDuration(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}min ${remainder}s` : `${minutes}min`;
}

/** Wait before a step, in operator words ("Espera de 2 h", "Envio na hora"). */
function formatJourneyDelay(seconds: number) {
  if (!seconds) return "Envio na hora";
  const decimal = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
  if (seconds < 60) return `Espera de ${seconds}s`;
  if (seconds < 3600) return `Espera de ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `Espera de ${decimal(seconds / 3600)} h`;
  const days = seconds / 86400;
  return `Espera de ${decimal(days)} ${days === 1 ? "dia" : "dias"}`;
}

function voiceStatusLabel(status: string, providerStatus: string | null) {
  if (providerStatus === "answered") return "Concluída";
  const labels: Record<string, string> = {
    pending_audio: "Preparando áudio",
    audio_ready: "Aguardando envio",
    queued: "Na fila",
    waiting_provider: "Aguardando provedor",
    calling: "Chamando",
    completed: "Concluída",
    failed: "Falhou",
    cancelled: "Cancelada",
    paused: "Pausada",
  };
  return labels[status] ?? status;
}

function voiceResultLabel(result: string | null) {
  if (!result) return "Aguardando resultado";
  const labels: Record<string, string> = {
    answered: "Atendida",
    completed: "Concluída",
    busy: "Ocupado",
    not_answered: "Não atendida",
    failed: "Falhou",
  };
  return labels[result] ?? result;
}

async function downloadUnresolved(sourceId: string) {
  const result = await exportCampaignUnresolvedCsv({ data: { campaignId: sourceId } });
  const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nao-enviados-${sourceId}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadRecipients(sourceId: string) {
  const result = await exportCampaignRecipientsCsv({ data: { campaignId: sourceId } });
  const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `destinatarios-${sourceId}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
