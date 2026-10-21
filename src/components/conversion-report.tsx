import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Download, X } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Recipient = {
  id: string;
  playerName: string;
  contact: string;
  sendStatus: string;
  deliveryStatus: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  clicked: boolean;
  clickCount: number;
  clickedAt: string | null;
  registeredAt: string | null;
  loginOrGameAt: string | null;
  firstDepositAt: string | null;
  depositAt: string | null;
  depositValue: number;
  /** Deposit of a player already active at the click: shown, never counted. */
  activeDepositAt?: string | null;
  activeDepositValue?: number;
  historicalDepositCount: number;
  historicalDepositValue: number;
};

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

const money = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const number = (value: number) => value.toLocaleString("pt-BR");
const percent = (part: number, whole: number) =>
  `${((part / whole) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const ratio = (value: number) =>
  value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

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
    return <ReportState>Carregando relatório…</ReportState>;
  if (sourceType === "campaign" && campaignDetails.isError)
    return <ReportState>Não foi possível carregar o relatório.</ReportState>;
  if (sourceType === "journey" && journeyDetails.isError)
    return <ReportState>Não foi possível carregar o relatório.</ReportState>;

  if (sourceType === "campaign" && isVoice && campaignDetails.data)
    return <VoiceCampaignReport details={campaignDetails.data} />;

  if (query.isError || !query.data)
    return <ReportState>Não foi possível carregar o relatório.</ReportState>;

  if (sourceType === "journey")
    return (
      <JourneyReport
        data={query.data}
        details={journeyDetails.data}
        drilldown={drilldown.data}
        onLoadDrilldown={() => setLoadJourneyDrilldown(true)}
        alerts={health.data?.alerts ?? []}
        globalAttributionHealth={health.data?.globalAttributionHealth ?? undefined}
      />
    );

  return (
    <CampaignReport
      sourceId={sourceId}
      data={query.data}
      details={campaignDetails.data}
      detailsError={campaignDetails.isError}
      alerts={health.data?.alerts ?? []}
      globalAttributionHealth={health.data?.globalAttributionHealth ?? undefined}
    />
  );
}

function VoiceCampaignReport({
  details,
}: {
  details: Awaited<ReturnType<typeof getCampaignReportDetails>>;
}) {
  const campaign = details.campaign;
  const voice = details.voice;
  if (!campaign || campaign.channel !== "voice" || !voice)
    return <ReportState>Não foi possível carregar o relatório de voz.</ReportState>;

  const status = voiceStatusLabel(voice.queueStatus, voice.providerStatus);
  const answeredLabel = voice.answered
    ? "Sim"
    : ["completed", "failed", "cancelled"].includes(voice.queueStatus)
      ? "Não"
      : "Aguardando";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm">
      <main className="mx-auto min-h-full max-w-5xl border-x border-border/70 bg-background shadow-2xl">
        <header className="sticky top-0 z-20 flex items-start justify-between gap-4 border-b border-border/70 bg-background/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Link
                to="/campanhas"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Voltar"
              >
                <ArrowLeft className="size-4" />
              </Link>
              <h1 className="truncate text-base font-bold">{campaign.name}</h1>
            </div>
            <p className="text-xs text-sky-400">Relatório operacional da ligação de voz</p>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/campanhas" aria-label="Fechar relatório">
              <X className="size-4" />
            </Link>
          </Button>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          <section className="grid gap-3 rounded-xl bg-card/60 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <TimelineValue label="Criada em" value={dateTime(campaign.createdAt)} />
            <TimelineValue label="Agendada para" value={dateTime(campaign.scheduledAt)} />
            <TimelineValue label="Tentativa iniciada" value={dateTime(voice.attemptedAt)} />
            <TimelineValue label="Canal" value="Infobip Voice" />
          </section>

          <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric label="Status" value={status} />
            <Metric label="Atendida" value={answeredLabel} accent={voice.answered} />
            <Metric
              label="Tempo de chamada"
              value={formatCallDuration(voice.durationSeconds)}
              hint={voice.durationSeconds === null ? "não informado pelo provedor" : undefined}
            />
            <Metric
              label="Tentativas"
              value={number(Math.max(voice.attempts, voice.attemptedAt ? 1 : 0))}
            />
          </section>

          {voice.error ? (
            <section className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
              <p className="text-xs text-rose-300">Motivo da falha</p>
              <p className="mt-1 text-sm font-semibold">{voice.error}</p>
            </section>
          ) : null}

          <section className="rounded-2xl border border-border/80 p-4">
            <h2 className="mb-3 text-sm font-semibold">Resultado da ligação</h2>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <VoiceDetail label="Destinatário" value={voice.playerName ?? "Não identificado"} />
              <VoiceDetail label="Telefone" value={voice.phone ?? "Não informado"} />
              <VoiceDetail label="Resultado" value={voiceResultLabel(voice.result)} />
              <VoiceDetail label="Status no provedor" value={voice.providerStatus ?? "—"} />
              <VoiceDetail label="Provedor" value={voice.provider ?? "Infobip"} />
              <VoiceDetail
                label="Código HTTP do provedor"
                value={voice.providerStatusCode === null ? "—" : String(voice.providerStatusCode)}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Conteúdo da ligação</h2>
            <div className="rounded-xl border bg-card/40 p-3 text-sm font-medium">
              {campaign.content ?? "O conteúdo original não está disponível para esta ligação."}
            </div>
          </section>

          {voice.providerCallId ? (
            <p className="text-xs text-muted-foreground">
              Identificador no provedor: <span className="font-mono">{voice.providerCallId}</span>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function VoiceDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card/60 p-3">
      <p className="text-xs text-sky-300">{label}</p>
      <p className="mt-1 break-words font-semibold">{value}</p>
    </div>
  );
}

function CampaignReport({
  sourceId,
  data,
  details,
  detailsError,
  alerts,
  globalAttributionHealth,
}: {
  sourceId: string;
  data: Awaited<ReturnType<typeof getConversionReport>>;
  details: Awaited<ReturnType<typeof getCampaignReportDetails>> | undefined;
  detailsError: boolean;
  alerts: Array<{ code: string; message: string }>;
  globalAttributionHealth?: { count: number; periodHours: number; reasons: Record<string, number> };
}) {
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const campaign = details?.campaign;
  const recipients = useMemo(
    () => (details?.recipients ?? []) as Recipient[],
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
  // SMS (Short Brasil) never confirms delivery: show only sent and failed.
  const showDelivered = campaign?.channel !== "sms" && data.delivered !== null;
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
  const stopReason = campaign
    ? campaignStopReason(campaign.status, campaign.lastError, campaign.finishedAt)
    : null;

  const setActiveFilter = (next: RecipientFilter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm">
      <main className="mx-auto min-h-full max-w-5xl border-x border-border/70 bg-background shadow-2xl">
        <header className="sticky top-0 z-20 flex items-start justify-between gap-4 border-b border-border/70 bg-background/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Link
                to="/campanhas"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Voltar"
              >
                <ArrowLeft className="size-4" />
              </Link>
              <h1 className="truncate text-base font-bold">
                {campaign?.name ?? "Relatório da campanha"}
              </h1>
            </div>
            <p className="text-xs text-sky-400">
              {depositors
                ? depositors === 1
                  ? "1 jogador depositou após a campanha"
                  : `${number(depositors)} jogadores depositaram após a campanha`
                : `${number(audience)} destinatários no público`}
            </p>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/campanhas" aria-label="Fechar relatório">
              <X className="size-4" />
            </Link>
          </Button>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          {stopReason && campaign ? (
            <section className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
              <p className="font-semibold">
                {getChannelOperationState(campaign.status, campaign.channel).label}
              </p>
              <p className="mt-1 text-muted-foreground">{stopReason}</p>
            </section>
          ) : null}
          <section className="grid gap-3 rounded-xl bg-card/60 p-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
            <TimelineValue label="Criada em" value={dateTime(campaign?.createdAt)} />
            <TimelineValue label="Disparo iniciado" value={dateTime(campaign?.scheduledAt)} />
            <TimelineValue label="Disparo concluído" value={dateTime(campaign?.finishedAt)} />
            <TimelineValue
              label="Atribuição"
              value="até 7 dias após o clique"
              className="sm:col-span-2"
            />
            <TimelineValue
              label="Medição"
              value="link curto — clique é contado"
              className="sm:col-span-2 lg:col-span-3"
            />
          </section>

          {alerts.map((alert) => (
            <div
              key={alert.code}
              className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
              {alert.message}
            </div>
          ))}
          {globalAttributionHealth?.count ? (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm">
              <p className="font-semibold">Saúde geral da integração</p>
              <p className="mt-1 text-muted-foreground">
                {number(globalAttributionHealth.count)} evento(s) da operação chegaram sem origem
                identificada nas últimas {globalAttributionHealth.periodHours} horas. Indicador
                geral, não relacionado a esta campanha.
              </p>
              <p className="mt-1 text-xs text-sky-300">
                {Object.entries(globalAttributionHealth.reasons)
                  .map(([reason, count]) => `${reason}: ${number(count)}`)
                  .join(" · ")}
              </p>
            </div>
          ) : null}

          {campaign?.failed || failureReasons.length > 0 ? (
            <section className="rounded-2xl border border-border/80 p-4">
              <h2 className="mb-3 text-sm font-semibold">Por que não saiu</h2>
              <div className="space-y-2">
                {failureReasons.length ? (
                  failureReasons.slice(0, 4).map(([reason, count]) => (
                    <div key={reason} className="rounded-xl bg-card/60 p-3">
                      <p className="text-sm font-semibold">
                        <span className="mr-2 text-sky-300">{number(count)}</span>
                        {reason}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Este envio não foi aceito ou concluído pelo provedor.
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-card/60 p-3">
                    <p className="text-sm font-semibold">
                      <span className="mr-2 text-sky-300">{number(campaign?.failed ?? 0)}</span>Não
                      enviados
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      O provedor não retornou um motivo individual para estes destinatários.
                    </p>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {details?.unresolved && details.unresolved.total > 0 ? (
            <UnresolvedRecipientsCard
              sourceId={sourceId}
              unresolved={details.unresolved}
              canExport={Boolean(data.canViewSensitive)}
            />
          ) : null}

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Enviados" value={number(data.sent)} />
            <Metric label="Deduplicados" value={number(data.deduplicated)} />
            {showDelivered ? <Metric label="Entregues" value={number(delivered)} /> : null}
            <Metric
              label="Clicaram"
              value={data.clicked === null ? "—" : number(clicked)}
              hint={
                reached
                  ? `${percent(clicked, reached)} ${delivered ? "de quem recebeu" : "dos enviados"}`
                  : undefined
              }
            />
            <Metric label="Cadastros" value={number(data.registered)} hint="jogadores" />
            <Metric
              label="Login ou jogo"
              value={number(data.loginOrGame)}
              hint={clicked ? `${percent(data.loginOrGame, clicked)} de quem clicou` : "jogadores"}
            />
            <Metric label="Primeiro depósito" value={number(data.ftd)} hint="jogadores" accent />
            <Metric
              label="Depositaram"
              value={number(depositors)}
              hint={clicked ? `${percent(depositors, clicked)} de quem clicou` : undefined}
              accent
            />
          </section>

          <section className="rounded-xl border border-emerald-500/10 bg-emerald-500/10 p-4">
            <p className="text-xs text-emerald-300">Total da campanha, desde o disparo</p>
            <p className="mt-1 text-2xl font-bold text-emerald-400">{money(directRevenue)}</p>
            <p className="mt-1 text-xs text-sky-300">
              de {number(depositors)}{" "}
              {depositors === 1 ? "jogador atribuído" : "jogadores atribuídos"} pelo último clique
              em até 7 dias
            </p>
            <ActiveNote players={data.activeDepositors} revenue={data.activeRevenue} />
            {data.assistedRevenue > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Receita assistida, separada: {money(data.assistedRevenue)}
              </p>
            ) : null}
          </section>

          <section className="grid gap-2 sm:grid-cols-3">
            <Metric
              label={campaign?.channel === "email" ? "Consumo de e-mail" : "Custo em SMS"}
              value={smsCost === null ? `${number(data.sent)} envios` : money(smsCost)}
              hint={
                smsCost === null
                  ? "custo financeiro indisponível"
                  : `${number(data.sent)} envios × ${money(data.smsPrice ?? 0)}`
              }
            />
            <Metric
              label="Retorno"
              value={smsCost ? `${ratio(directRevenue / smsCost)}x` : "—"}
              hint={smsCost ? "total da campanha ÷ custo em SMS" : "sem custo de envio"}
            />
            <Metric
              label="Receita média por jogador que voltou"
              value={depositors ? money(revenuePerPlayer) : "—"}
              hint={`${number(depositors)} ${depositors === 1 ? "jogador atribuído" : "jogadores atribuídos"}`}
            />
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">A mensagem que foi enviada</h2>
              <Button size="sm" asChild>
                <a href="/campanhas?newCampaign=1">Usar</a>
              </Button>
            </div>
            <div className="rounded-xl border bg-card/40 p-3 text-sm font-medium">
              {campaign?.content ?? "O conteúdo original não está disponível para esta campanha."}
            </div>
            <p className="mt-2 text-xs text-sky-300">
              Os links saíram encurtados e medidos. “Usar” abre uma nova campanha sem alterar esta.
            </p>
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Destinatários</h2>
              <Button
                size="sm"
                variant="ghost"
                disabled={!data.canViewSensitive}
                onClick={() => void downloadRecipients(sourceId)}
              >
                <Download className="mr-1.5 size-4" /> Baixar CSV
              </Button>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <FilterButton active={filter === "all"} onClick={() => setActiveFilter("all")}>
                Todos {number(audience)}
              </FilterButton>
              <FilterButton active={filter === "sent"} onClick={() => setActiveFilter("sent")}>
                Enviados {number(data.sent)}
              </FilterButton>
              {showDelivered ? (
                <FilterButton
                  active={filter === "delivered"}
                  onClick={() => setActiveFilter("delivered")}
                >
                  Entregues {number(delivered)}
                </FilterButton>
              ) : null}
              <FilterButton
                active={filter === "clicked"}
                onClick={() => setActiveFilter("clicked")}
              >
                Clicaram {number(clicked)}
              </FilterButton>
              <FilterButton
                active={filter === "not-clicked"}
                onClick={() => setActiveFilter("not-clicked")}
              >
                Não clicaram {number(notClicked)}
              </FilterButton>
              <FilterButton
                active={filter === "registered"}
                onClick={() => setActiveFilter("registered")}
              >
                Cadastros {number(data.registered)}
              </FilterButton>
              <FilterButton
                active={filter === "engaged"}
                onClick={() => setActiveFilter("engaged")}
              >
                Login ou jogo {number(data.loginOrGame)}
              </FilterButton>
              <FilterButton
                active={filter === "first-deposit"}
                onClick={() => setActiveFilter("first-deposit")}
                tone="green"
              >
                Primeiro depósito {number(data.ftd)}
              </FilterButton>
              <FilterButton
                active={filter === "deposited"}
                onClick={() => setActiveFilter("deposited")}
                tone="green"
              >
                Depositaram {number(depositors)}
              </FilterButton>
              <FilterButton
                active={filter === "clicked-no-deposit"}
                onClick={() => setActiveFilter("clicked-no-deposit")}
                tone="orange"
              >
                Clicaram e não depositaram {number(clickedNoDeposit)}
              </FilterButton>
            </div>
            {listIsPartial && details ? (
              <p className="mb-3 text-xs text-muted-foreground">
                Os números dos filtros são da campanha inteira. A lista abaixo mostra só os
                primeiros {number(details.recipientsShown)} de {number(audience)} destinatários; o
                CSV traz todos.
              </p>
            ) : null}

            {detailsError ? (
              <div className="rounded-xl border p-5 text-sm text-muted-foreground">
                Os totais estão disponíveis, mas não foi possível carregar a lista individual.
              </div>
            ) : recipients.length === 0 ? (
              <div className="rounded-xl border p-5 text-sm text-muted-foreground">
                Esta campanha não possui destinatários rastreáveis individualmente.
              </div>
            ) : (
              <>
                <RecipientTable rows={visible} />
                <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-sky-300">
                  <span>
                    {number(filtered.length)} linhas · página {page} de {pages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page === 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      <ChevronLeft className="mr-1 size-4" />
                      Anterior
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page === pages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Próxima
                      <ChevronRight className="ml-1 size-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </section>

          {recipients.some((row) => row.depositAt) ? (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Quem clicou e depositou</h2>
              <ConversionTable rows={recipients.filter((row) => row.depositAt)} />
              <p className="mt-3 text-xs text-sky-300">
                A atribuição exige vínculo individual com o clique; depósitos sem esse vínculo não
                inflam este resultado.
              </p>
            </section>
          ) : null}
        </div>
      </main>
    </div>
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
    <section
      className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4"
      aria-labelledby="unresolved-recipients-title"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="unresolved-recipients-title" className="text-sm font-semibold">
            Não enviados ({number(unresolved.total)})
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Estes destinatários ficaram fora da campanha; os demais receberam normalmente.
          </p>
        </div>
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
          <Download className="mr-1.5 size-4" />
          {exporting ? "Gerando…" : "Baixar CSV"}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {reasons.map((reason) => (
          <div key={reason} className="rounded-xl bg-card/60 p-3">
            <p className="text-sm font-semibold">
              <span className="mr-2 text-amber-300">{number(unresolved.byReason[reason])}</span>
              {UNRESOLVED_REASON_LABEL[reason]}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{UNRESOLVED_REASON_HINT[reason]}</p>
          </div>
        ))}
      </div>
      {unresolved.sample.length > 0 ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-sky-300">
            Ver os primeiros {number(unresolved.sample.length)}
          </summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {unresolved.sample.map((row, index) => (
              <li
                key={`${row.phone}-${row.reason}-${index}`}
                className="flex justify-between gap-2 rounded-lg bg-card/60 px-3 py-1.5"
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
  );
}

function RecipientTable({ rows }: { rows: Recipient[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[1180px] text-xs">
        <thead>
          <tr className="border-b text-left text-sky-200">
            <th className="p-3">Jogador</th>
            <th className="p-3">Envio</th>
            <th className="p-3">Clique</th>
            <th className="p-3 text-right">Cliques</th>
            <th className="p-3">Cadastro</th>
            <th className="p-3">Login ou jogo</th>
            <th className="p-3">Primeiro depósito</th>
            <th className="p-3">Depósito</th>
            <th className="p-3 text-right">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="p-3">
                <strong className="block max-w-48 truncate text-sm">{row.playerName}</strong>
                <span className="text-sky-300">
                  {row.deliveryStatus === "delivered" ? "entregue" : row.sendStatus}
                </span>
              </td>
              <td className="p-3 text-sky-300">{dateTime(row.sentAt)}</td>
              <td className={cn("p-3", row.clicked && "font-medium text-blue-400")}>
                {dateTime(row.clickedAt)}
              </td>
              <td className="p-3 text-right font-semibold">{row.clickCount || "—"}</td>
              <td className="p-3 text-sky-300">{dateTime(row.registeredAt)}</td>
              <td className="p-3 text-sky-300">{dateTime(row.loginOrGameAt)}</td>
              <td className="p-3 text-sky-300">{dateTime(row.firstDepositAt)}</td>
              <td className="p-3 text-sky-300">
                {row.activeDepositAt ? (
                  <span className="text-muted-foreground">
                    {dateTime(row.activeDepositAt)} · já ativo
                  </span>
                ) : (
                  dateTime(row.depositAt)
                )}
              </td>
              <td
                className={cn(
                  "p-3 text-right",
                  row.depositValue > 0 && "font-bold text-emerald-400",
                )}
              >
                {row.depositValue ? (
                  money(row.depositValue)
                ) : row.activeDepositValue ? (
                  <span className="text-muted-foreground">{money(row.activeDepositValue)}</span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Click deposits of players already active: reported apart, never in the totals. */
function ActiveNote({ players, revenue }: { players?: number; revenue?: number }) {
  if (!players) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Fora da conta: {number(players)} {players === 1 ? "jogador já ativo" : "jogadores já ativos"}{" "}
      (depositaram nas 48 h antes do clique) somaram {money(revenue ?? 0)} depois de clicar.
    </p>
  );
}

function ConversionTable({ rows }: { rows: Recipient[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[680px] text-xs">
        <thead>
          <tr className="border-b text-left text-sky-200">
            <th className="p-3">Jogador</th>
            <th className="p-3">Clicou</th>
            <th className="p-3">Depositou</th>
            <th className="p-3">Depois de</th>
            <th className="p-3 text-right">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const elapsed =
              row.clickedAt && row.depositAt
                ? Math.max(0, new Date(row.depositAt).getTime() - new Date(row.clickedAt).getTime())
                : null;
            return (
              <tr key={row.id} className="border-b last:border-0">
                <td className="p-3">
                  <strong className="block text-sm">{row.playerName}</strong>
                  <span className="text-sky-300">
                    {number(row.historicalDepositCount)} depósitos no histórico ·{" "}
                    {money(row.historicalDepositValue)}
                  </span>
                </td>
                <td className="p-3 text-sky-300">{dateTime(row.clickedAt)}</td>
                <td className="p-3 font-semibold">{dateTime(row.depositAt)}</td>
                <td className="p-3 text-sky-300">{formatElapsed(elapsed)}</td>
                <td className="p-3 text-right font-bold text-emerald-400">
                  {money(row.depositValue)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function JourneyReport({
  data,
  details,
  drilldown,
  onLoadDrilldown,
  alerts,
  globalAttributionHealth,
}: {
  data: Awaited<ReturnType<typeof getConversionReport>>;
  details: Awaited<ReturnType<typeof getJourneyReportDetails>> | undefined;
  drilldown: Awaited<ReturnType<typeof getConversionDrilldown>> | undefined;
  onLoadDrilldown: () => void;
  alerts: Array<{ code: string; message: string }>;
  globalAttributionHealth?: { count: number; periodHours: number; reasons: Record<string, number> };
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

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm">
      <main className="mx-auto min-h-full max-w-6xl border-x border-border/70 bg-background shadow-2xl">
        <header className="sticky top-0 z-20 flex items-start justify-between gap-4 border-b border-border/70 bg-background/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Link
                to="/jornadas"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Voltar para jornadas"
              >
                <ArrowLeft className="size-4" />
              </Link>
              <h1 className="truncate text-base font-bold">
                {journey?.name ?? "Relatório da jornada"}
              </h1>
            </div>
            <p className="text-xs text-sky-400">
              {rotatesCopies ? "Resultado de cada copy" : "Resultado de cada etapa"} · atribuição
              por último clique em até 7 dias
            </p>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/jornadas" aria-label="Fechar relatório">
              <X className="size-4" />
            </Link>
          </Button>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          <section className="rounded-xl border bg-card/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                Evento: {triggerName}
              </span>
              {journey?.status ? (
                <span className="rounded-full border px-2.5 py-1 text-xs capitalize text-muted-foreground">
                  {journey.status}
                </span>
              ) : null}
            </div>
            {journey?.description ? (
              <p className="mt-3 text-sm text-muted-foreground">{journey.description}</p>
            ) : null}
          </section>

          {alerts.map((alert) => (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
              key={alert.code}
            >
              {alert.message}
            </div>
          ))}
          {globalAttributionHealth?.count ? (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm">
              <strong>Saúde geral da integração:</strong> {number(globalAttributionHealth.count)}{" "}
              evento(s) da operação sem origem identificada nas últimas{" "}
              {globalAttributionHealth.periodHours} horas. Indicador geral, não relacionado a esta
              jornada.
            </div>
          ) : null}
          {data.truncated || details?.metrics?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Volume muito alto: alguns números abaixo consideram apenas os primeiros 100 mil
              registros.
            </p>
          ) : null}
          {sent7d > 0 && data.trackedSent === 0 ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-100">
              Esta jornada enviou mensagens, mas nenhuma continha link rastreável. Por isso clique,
              depósito atribuído e recuperado permanecem em zero; não é falha de sincronização.
            </div>
          ) : null}
          {data.observedClicked && data.observedClicked > (data.clicked ?? 0) ? (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-muted-foreground">
              O Short.io observou {number(data.observedClicked)} clique(s), mas apenas{" "}
              {number(data.clicked ?? 0)}
              foi(ram) confirmado(s) pelo redirecionamento próprio. Os observados não entram em
              atribuição.
            </div>
          ) : null}

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <Metric label="Entraram (7 dias)" value={number(details?.metrics?.entered7d ?? 0)} />
            <Metric label="Em andamento" value={number(details?.metrics?.inProgress ?? 0)} />
            <Metric label="Enviados 7d" value={number(sent7d)} />
            <Metric
              label="Enviados rastreados"
              value={number(data.trackedSent)}
              hint="Desde o início, com link rastreado — inclui etapas hoje desativadas"
            />
            <Metric label="Clicaram" value={data.clicked === null ? "—" : number(data.clicked)} />
            <Metric label="Depósitos atribuídos" value={number(deposits)} />
            <Metric label="Recuperado pelo CRM" value={money(recovered)} accent />
          </section>
          <ActiveNote players={data.activeDepositors} revenue={data.activeRevenue} />

          <section className="rounded-2xl border border-border/80">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">Os degraus — resultado de cada etapa</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Envios vêm da execução da jornada; cliques, depósitos e valor recuperado usam o
                vínculo rastreado de cada etapa.
              </p>
            </div>
            {stepRows.length ? (
              <TooltipProvider delayDuration={150}>
                <div className="divide-y divide-border/70">
                  {stepRows.map((step, index) => (
                    <div key={step.id} className="space-y-3 p-4">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="grid size-6 place-items-center rounded-full bg-muted text-xs font-bold">
                          {index + 1}
                        </span>
                        <span className="rounded-full border border-sky-500/30 bg-sky-500/5 px-2 py-0.5 text-xs font-semibold uppercase text-sky-300">
                          {step.step_type}
                        </span>
                        <strong>{step.label || `Etapa ${index + 1}`}</strong>
                        <span className="text-xs text-muted-foreground">
                          {formatJourneyDelay(step.waitSeconds)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                        <JourneyStepMetric
                          label="Neste degrau agora"
                          value={step.current}
                          hint="Leads que já entraram e aguardam o envio ou o próximo passo deste degrau"
                        />
                        <JourneyStepMetric label="Enviados 7d" value={step.sent7d} />
                        <JourneyStepMetric label="Enviados total" value={step.sent} />
                        {step.step_type === "sms" ? null : (
                          <JourneyStepMetric label="Entregues" value={step.delivered} />
                        )}
                        <JourneyStepMetric label="Clicaram" value={step.clicked} />
                        <JourneyStepMetric label="Depósitos atribuídos" value={step.deposits} />
                        <JourneyStepMetric
                          label="Recuperado pelo CRM"
                          value={step.recovered}
                          currency
                          accent
                        />
                      </div>
                      {step.copies.length > 1 || step.variants.length ? (
                        <JourneyCopyTable
                          copies={step.copies}
                          variants={step.variants}
                          withoutVariant={step.withoutVariant}
                        />
                      ) : null}
                    </div>
                  ))}
                  {retiredSteps.length ? (
                    <div className="space-y-2 bg-muted/20 p-4">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">
                        Etapas desativadas — histórico
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Etapas que enviaram mensagens e depois foram desligadas. O resultado delas
                        continua contando no total da jornada.
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[520px] text-sm">
                          <thead className="text-xs text-muted-foreground">
                            <tr className="text-left">
                              <th className="py-1.5 pr-3 font-medium">Etapa</th>
                              <th className="py-1.5 pr-3 text-right font-medium">Enviados</th>
                              <th className="py-1.5 pr-3 text-right font-medium">Clicaram</th>
                              <th className="py-1.5 pr-3 text-right font-medium">Depósitos</th>
                              <th className="py-1.5 text-right font-medium">Recuperado</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/50">
                            {retiredSteps.map((step) => (
                              <tr key={step.stepId} className="text-muted-foreground">
                                <td className="py-1.5 pr-3">
                                  {step.label || `Etapa na posição ${step.stepPosition}`}
                                </td>
                                <td className="py-1.5 pr-3 text-right">{number(step.sent)}</td>
                                <td className="py-1.5 pr-3 text-right">{number(step.clicked)}</td>
                                <td className="py-1.5 pr-3 text-right">{number(step.deposits)}</td>
                                <td className="py-1.5 text-right">{money(step.recovered)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                  {unassigned.deposits > 0 ? (
                    <p className="px-4 py-3 text-xs text-muted-foreground">
                      Sem degrau identificado: {number(unassigned.deposits)} depósito(s) ·{" "}
                      {money(unassigned.recovered)} — o envio de origem não corresponde a nenhuma
                      etapa da jornada.
                    </p>
                  ) : null}
                </div>
              </TooltipProvider>
            ) : (
              <p className="p-5 text-sm text-muted-foreground">
                Esta jornada ainda não possui etapas de comunicação configuradas.
              </p>
            )}
          </section>

          {failed ? (
            <p className="text-xs text-amber-300">
              {number(failed)} execução(ões) falharam ou foram canceladas nas etapas acima.
            </p>
          ) : null}

          <section className="rounded-2xl border border-border/80">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">Leads rastreados</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Clique, login e depósito só aparecem quando pertencem ao mesmo envio rastreado.
              </p>
            </div>
            {!drilldown ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">
                  Carregue os detalhes individuais sob demanda para não atrasar o relatório.
                </p>
                <Button className="mt-3" size="sm" variant="outline" onClick={onLoadDrilldown}>
                  Carregar leads rastreados
                </Button>
              </div>
            ) : drilldown.rows.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Ainda não há envios rastreáveis nesta jornada.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Lead</th>
                      <th className="px-4 py-3 font-medium">Enviado</th>
                      <th className="px-4 py-3 font-medium">Clicou</th>
                      <th className="px-4 py-3 font-medium">Login/jogo</th>
                      <th className="px-4 py-3 font-medium">Depósito</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {drilldown.rows.map((row, index) => (
                      <tr key={`${row.playerId}-${row.sentAt}-${index}`}>
                        <td className="px-4 py-3">
                          <p className="font-medium">{row.playerName}</p>
                          <p className="text-muted-foreground">{row.contact ?? "—"}</p>
                        </td>
                        <td className="px-4 py-3">{dateTime(row.sentAt)}</td>
                        <td className="px-4 py-3">{dateTime(row.clickedAt)}</td>
                        <td className="px-4 py-3">{dateTime(row.loginAt)}</td>
                        <td className="px-4 py-3">
                          {row.depositedAt
                            ? `${dateTime(row.depositedAt)} · ${money(row.depositValue)}${
                                row.alreadyActive ? " · já ativo, não conta" : ""
                              }`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
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
    name: `Copy ${index + 1}`,
    text: copies[index] ?? "Copy removida",
    ...(byIndex.get(index) ?? empty),
  }));
  if (withoutVariant && (withoutVariant.sent > 0 || withoutVariant.deposits > 0))
    rows.push({
      key: "none",
      name: "Sem copy registrada",
      text: "Envios anteriores à rotação de copys",
      ...withoutVariant,
    });
  const rate = (row: { sent: number; clicked: number }) =>
    row.sent ? `${((row.clicked / row.sent) * 100).toFixed(1).replace(".", ",")}%` : "—";
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/30 text-xs text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">Copy (rotação)</th>
            <th className="px-3 py-2 text-right font-medium">Enviados</th>
            <th className="px-3 py-2 text-right font-medium">Clicaram</th>
            <th className="px-3 py-2 text-right font-medium">Taxa de clique</th>
            <th className="px-3 py-2 text-right font-medium">Depósitos</th>
            <th className="px-3 py-2 text-right font-medium">Recuperado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="max-w-[320px] px-3 py-2">
                <div className="font-medium">{row.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={row.text}>
                  {row.text}
                </div>
              </td>
              <td className="px-3 py-2 text-right">{number(row.sent)}</td>
              <td className="px-3 py-2 text-right">{number(row.clicked)}</td>
              <td className="px-3 py-2 text-right">{rate(row)}</td>
              <td className="px-3 py-2 text-right">{number(row.deposits)}</td>
              <td className="px-3 py-2 text-right font-semibold text-emerald-400">
                {money(row.recovered)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JourneyStepMetric({
  label,
  value,
  hint,
  currency = false,
  accent = false,
}: {
  label: string;
  value: number;
  hint?: string;
  currency?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-card/60 px-3 py-2">
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p
              tabIndex={0}
              className="cursor-help text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2"
            >
              {label}
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">{hint}</TooltipContent>
        </Tooltip>
      ) : (
        <p className="text-[11px] text-muted-foreground">{label}</p>
      )}
      <p className={cn("mt-0.5 font-bold", accent && "text-emerald-400")}>
        {currency ? money(value) : number(value)}
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={cn("rounded-xl bg-card/60 p-3", accent && "bg-emerald-500/10")}>
      <p className={cn("text-xs text-sky-300", accent && "text-emerald-300")}>{label}</p>
      <p className={cn("mt-1 text-xl font-bold", accent && "text-emerald-400")}>{value}</p>
      {hint ? <p className="text-xs text-sky-300">{hint}</p> : null}
    </div>
  );
}

function TimelineValue({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-sky-300">{label}</p>
      <p className="font-semibold text-foreground">{value}</p>
    </div>
  );
}

function FilterButton({
  active,
  tone = "blue",
  onClick,
  children,
}: {
  active: boolean;
  tone?: "blue" | "green" | "orange";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
        active ? "border-blue-500 bg-blue-600 text-white" : "bg-card/60 hover:bg-card",
        tone === "green" && !active && "border-emerald-500/30 text-emerald-400",
        tone === "orange" && !active && "border-orange-500/30 text-orange-400",
      )}
    >
      {children}
    </button>
  );
}

function ReportState({ children }: { children: React.ReactNode }) {
  return (
    <main className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6 text-sm text-muted-foreground">
      {children}
    </main>
  );
}

function formatElapsed(value: number | null) {
  if (value === null) return "—";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function formatCallDuration(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}min ${remainder}s` : `${minutes}min`;
}

function formatJourneyDelay(seconds: number) {
  if (!seconds) return "na hora";
  if (seconds < 60) return `${seconds}s depois`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min depois`;
  if (seconds < 86400) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h depois`;
  }
  const days = seconds / 86400;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} d depois`;
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
