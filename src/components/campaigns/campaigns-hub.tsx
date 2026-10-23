import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Megaphone, Plus, Search, Send, Trash2, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { ChannelCampaignComposer } from "@/components/campaigns/channel-campaign-composer";
import { IndividualSmsDialog } from "@/components/campaigns/individual-sms-dialog";
import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { SegmentedFilter } from "@/components/players/segmented-filter";
import { requestConfirmation } from "@/components/system-dialog-host";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageHeader } from "@/components/ui-premium/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import {
  audienceFromSearch,
  campaignStopReason,
  getChannelOperationState,
  groupVoiceQueueItems,
  isFinishedCampaignStatus,
  isPausedCampaignStatus,
  type VoiceQueueItem,
} from "@/lib/channel-operation-state";
import {
  cancelScheduledSmsCampaign,
  listScheduledSmsCampaigns,
  resumeSmsCampaign,
} from "@/lib/sms.functions";
import { listEmailCampaigns, sendEmailCampaignNow } from "@/lib/email.functions";
import {
  EMAIL_CAMPAIGN_RESEND_NOTE,
  alreadySentSuffix,
  campaignPausedForBalanceMessage,
  type EmailCampaignRunResult,
} from "@/lib/email-campaign-messages";
import { CampaignBlockedBadge } from "@/components/house-config/campaign-blocked-badge";
import { listCallQueue } from "@/lib/calls.functions";
import { deleteCampaignDraft, listCampaignDrafts } from "@/lib/campaign-drafts.functions";

type CampaignStatus = "todos" | "agendadas" | "enviando" | "pausadas" | "finalizadas";

const STATUS_FILTERS: ReadonlyArray<{ value: CampaignStatus; label: string }> = [
  { value: "todos", label: "Todas" },
  { value: "agendadas", label: "Agendadas" },
  { value: "enviando", label: "Enviando" },
  { value: "pausadas", label: "Pausadas" },
  { value: "finalizadas", label: "Finalizadas" },
];

const CHANNEL_LABEL: Record<"sms" | "email" | "voice", string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

/** KPIs cover the same window the SMS list is fetched with (listScheduledSmsCampaigns). */
const KPI_WINDOW_DAYS = 30;

function matchesStatus(filter: CampaignStatus, status: string) {
  if (filter === "todos") return true;
  if (filter === "agendadas") return ["agendada", "scheduled"].includes(status);
  if (filter === "enviando") return status === "enviando";
  // SMS/e-mail "pausada" (e.g. paused for balance) and voice "paused"/"paused_limit".
  if (filter === "pausadas") return isPausedCampaignStatus(status);
  return isFinishedCampaignStatus(status);
}
type Campaign = {
  id: string;
  name: string | null;
  scheduled_at: string;
  status: string;
  total_count: number | null;
  sent_count: number | null;
  deduplicated_count?: number | null;
  failed_count: number | null;
  /** Voice: calls the provider finished. */
  completed_count?: number | null;
  /** Items that will not change any more; feeds the progress of a voice campaign. */
  finished_count?: number | null;
  /**
   * Whether `total_count` is the planned audience. Without it the progress
   * cannot be computed (an e-mail campaign only knows what it already sent).
   */
  has_planned_total?: boolean;
  /** `scheduled_at` holds the creation date only (no time). */
  date_is_creation?: boolean;
  /** Voice campaigns grouped from more than one queue item have no single report. */
  has_report?: boolean;
  /** ENV-06: recipients skipped because they did not resolve to a player. */
  unresolved_count?: number | null;
  /** Why the campaign stopped (provider error, or who cancelled it). */
  last_error?: string | null;
  /** E-mail only: why the last send attempt was blocked (sender/domain). */
  blocked_reason?: string | null;
  updated_at?: string | null;
  channel: "sms" | "email" | "voice";
  cancellable?: boolean;
  /** SMS paused for lack of balance: "Retomar" puts it back in the queue. */
  resumable?: boolean;
};

type EmailCampaignRow = {
  id: string;
  nome: string | null;
  agendadoPara: string | null;
  /** Creation date, dd/mm/aaaa. */
  data: string | null;
  status: string;
  blockedReason?: string | null;
  enviados: number;
  falhas: number;
};

type DraftSummary = {
  id: string;
  name: string;
  channel: "sms" | "email" | "voice";
  updatedAt: string;
};

export function CampaignsHub() {
  const queryClient = useQueryClient();
  const listCampaigns = useServerFn(listScheduledSmsCampaigns);
  const listEmailCampaignsFn = useServerFn(listEmailCampaigns);
  const listCallQueueFn = useServerFn(listCallQueue);
  const cancelCampaign = useServerFn(cancelScheduledSmsCampaign);
  const resumeCampaign = useServerFn(resumeSmsCampaign);
  const sendEmailNow = useServerFn(sendEmailCampaignNow);
  const listDrafts = useServerFn(listCampaignDrafts);
  const deleteDraftFn = useServerFn(deleteCampaignDraft);
  const [composerOpen, setComposerOpen] = useState(false);
  const [initialChannel, setInitialChannel] = useState<"sms" | "email" | "voice">("sms");
  const [initialAudienceId, setInitialAudienceId] = useState("");
  const [individualOpen, setIndividualOpen] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CampaignStatus>("todos");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("newChannel");
    if (requested === "email" || requested === "voice" || requested === "sms") {
      setInitialChannel(requested);
      setComposerOpen(true);
    } else if (params.get("newCampaign") === "1") {
      setInitialChannel("sms");
      // Any audience id the composer lists (system audiences and saved ones);
      // the composer ignores an id it does not know. Was limited to all-leads (D-04).
      setInitialAudienceId(audienceFromSearch(params.get("audience")));
      setComposerOpen(true);
    }
  }, []);

  const campaigns = useQuery({
    queryKey: ["sms-scheduled-campaigns"],
    queryFn: () => listCampaigns(),
    refetchInterval: 30_000,
  });
  const emailCampaigns = useQuery({
    queryKey: ["email-campaigns"],
    queryFn: () => listEmailCampaignsFn(),
    refetchInterval: 30_000,
  });
  const voiceQueue = useQuery({
    queryKey: ["call-queue", "campaigns-hub"],
    queryFn: () => listCallQueueFn({ data: { limit: 200, order: "recent" } }),
    refetchInterval: 30_000,
  });
  const drafts = useQuery({
    queryKey: ["campaign-drafts"],
    queryFn: () => listDrafts(),
    refetchInterval: 30_000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelCampaign({ data: { id } }),
    onSuccess: () => {
      toast.success("Campanha cancelada");
      queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const resume = useMutation({
    mutationFn: (id: string) => resumeCampaign({ data: { id } }),
    onSuccess: () => {
      toast.success("Campanha retomada. Se ainda faltar saldo, ela volta a pausar.");
      queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  // PG3: resuming a paused e-mail campaign is the same send-now run, which
  // skips the recipients this campaign already reached.
  const resumeEmail = useMutation({
    mutationFn: async (id: string) => {
      const toastId = toast.loading("Enviando campanha…");
      try {
        const r = (await sendEmailNow({ data: { campaignId: id } })) as EmailCampaignRunResult;
        if (r.pausadaPorSaldo) {
          toast.warning(campaignPausedForBalanceMessage(r), { id: toastId });
        } else {
          toast.success(
            `Campanha enviada: ${r.enviados ?? 0} ok, ${r.pendentes ?? 0} pendentes, ${r.falhas ?? 0} falhas (${r.total ?? 0} destinatários).${alreadySentSuffix(r)}`,
            { id: toastId },
          );
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Erro no envio", { id: toastId });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["email-campaigns"] }),
  });
  const removeDraft = useMutation({
    mutationFn: (id: string) => deleteDraftFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Rascunho excluído");
      queryClient.invalidateQueries({ queryKey: ["campaign-drafts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const smsCampaigns = ((campaigns.data?.campaigns ?? []) as Omit<Campaign, "channel">[]).map(
    (campaign) => ({
      ...campaign,
      channel: "sms" as const,
      cancellable: campaign.status === "agendada" || campaign.status === "pausada",
      resumable: campaign.status === "pausada",
    }),
  );
  const emailRows: Campaign[] = ((emailCampaigns.data?.items ?? []) as EmailCampaignRow[]).map(
    (campaign) => {
      // Without a schedule the row shows the creation date, never "now".
      const createdAt = parsePtBrDate(campaign.data);
      return {
        id: campaign.id,
        name: campaign.nome,
        scheduled_at: campaign.agendadoPara ?? createdAt ?? new Date(0).toISOString(),
        date_is_creation: !campaign.agendadoPara,
        status: campaign.status,
        total_count: campaign.enviados + campaign.falhas,
        sent_count: campaign.enviados,
        failed_count: campaign.falhas,
        blocked_reason: campaign.blockedReason ?? null,
        has_planned_total: false,
        channel: "email" as const,
        cancellable: false,
        resumable: campaign.status === "pausada",
      };
    },
  );
  // The queue has one item per call; group them back into campaigns.
  const voiceRows: Campaign[] = groupVoiceQueueItems(
    (voiceQueue.data?.items ?? []) as VoiceQueueItem[],
  ).map((group) => ({
    id: group.id,
    name: group.name,
    scheduled_at: group.scheduledAt,
    status: group.status,
    total_count: group.total,
    sent_count: group.sent,
    completed_count: group.completed,
    failed_count: group.failed,
    finished_count: group.finished,
    has_planned_total: true,
    has_report: group.total === 1,
    channel: "voice",
    cancellable: false,
  }));
  const all: Campaign[] = [...smsCampaigns, ...emailRows, ...voiceRows].sort(
    (a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime(),
  );
  const normalizedSearch = search.trim().toLowerCase();
  const rows = all.filter(
    (campaign) =>
      matchesStatus(status, campaign.status) &&
      (!normalizedSearch ||
        String(campaign.name ?? "")
          .toLowerCase()
          .includes(normalizedSearch)),
  );
  const statusCounts = Object.fromEntries(
    STATUS_FILTERS.map((item) => [
      item.value,
      all.filter((campaign) => matchesStatus(item.value, campaign.status)).length,
    ]),
  ) as Record<CampaignStatus, number>;

  // D-01/KPIs: one explicit window for every channel (the SMS list is already
  // limited to it; e-mail and voice are cut here so the totals mean the same thing).
  const kpiSince = Date.now() - KPI_WINDOW_DAYS * 86_400_000;
  const recent = all.filter((campaign) => new Date(campaign.scheduled_at).getTime() >= kpiSince);
  const sent = recent.reduce((sum, campaign) => sum + Number(campaign.sent_count ?? 0), 0);
  const failed = recent.reduce((sum, campaign) => sum + Number(campaign.failed_count ?? 0), 0);
  const queued = all.filter((campaign) =>
    ["agendada", "enviando"].includes(campaign.status),
  ).length;

  // D-26: skeleton only before the first answer; the 30s refetch is silent.
  const firstLoad =
    (campaigns.isLoading && !campaigns.data) ||
    (emailCampaigns.isLoading && !emailCampaigns.data) ||
    (voiceQueue.isLoading && !voiceQueue.data);
  const draftItems = (drafts.data?.items ?? []) as DraftSummary[];

  const openNewCampaign = () => {
    setActiveDraftId(null);
    setInitialAudienceId("");
    setInitialChannel("sms");
    setComposerOpen(true);
  };

  return (
    <>
      <PageHeader
        subtitle="Envie SMS, e-mail ou voz para um público e acompanhe o resultado de cada envio."
        actions={
          <>
            <Button variant="outline" onClick={() => setIndividualOpen(true)}>
              <Send /> Envio de teste
            </Button>
            <Button onClick={openNewCampaign}>
              <Plus /> Nova campanha
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          title="Enviados"
          value={firstLoad ? "—" : num(sent)}
          detail={`Campanhas dos últimos ${KPI_WINDOW_DAYS} dias`}
        />
        <KpiCard
          title="Falhas"
          value={firstLoad ? "—" : num(failed)}
          detail={`Recusados ou inválidos, últimos ${KPI_WINDOW_DAYS} dias`}
        />
        <KpiCard
          title="Em envio"
          value={firstLoad ? "—" : num(queued)}
          detail="Campanhas agendadas ou enviando agora"
        />
      </div>

      {draftItems.length > 0 && (
        <HomeCard>
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-section">Rascunhos</h2>
            <p className="text-meta text-muted-foreground">
              Salvos automaticamente enquanto você edita.
            </p>
          </div>
          <ul>
            {draftItems.map((draft) => {
              const draftName = draft.name || "Campanha sem nome";
              return (
                <li
                  key={draft.id}
                  className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium">{draftName}</p>
                    <p className="text-meta text-muted-foreground">
                      {CHANNEL_LABEL[draft.channel]} · editado em{" "}
                      {new Date(draft.updatedAt).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setActiveDraftId(draft.id);
                        setInitialChannel(draft.channel);
                        setComposerOpen(true);
                      }}
                    >
                      Continuar
                    </Button>
                    <IconButton
                      label={`Excluir rascunho ${draftName}`}
                      icon={<Trash2 />}
                      disabled={removeDraft.isPending}
                      onClick={async () => {
                        const confirmed = await requestConfirmation({
                          title: "Excluir rascunho?",
                          description: `O rascunho "${draftName}" será apagado e não poderá ser recuperado.`,
                          confirmLabel: "Excluir rascunho",
                          destructive: true,
                        });
                        if (confirmed) removeDraft.mutate(draft.id);
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </HomeCard>
      )}

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <SegmentedFilter
          label="Status da campanha"
          value={status}
          onValueChange={setStatus}
          items={STATUS_FILTERS.map((item) => ({
            ...item,
            count: firstLoad ? null : statusCounts[item.value],
          }))}
        />
        <div className="relative w-full lg:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar campanha pelo nome"
            placeholder="Buscar campanha"
            className="h-10 bg-card pl-9 pr-10"
          />
          {search && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setSearch("")}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <HomeCard className="overflow-hidden">
        {/* D-05: a grid only from xl up (with minmax(0,…) and sideways scroll as a
            safety net); below xl every campaign is a stacked row. */}
        <div className="overflow-x-auto">
          <div className="xl:min-w-[920px]">
            <div
              className={cn(ROW_GRID, "hidden border-b border-border py-2.5 xl:grid")}
              aria-hidden="true"
            >
              <span className="text-meta text-muted-foreground">Campanha</span>
              <span className="text-meta text-muted-foreground">Status</span>
              <span className="text-right text-meta text-muted-foreground">Enviados</span>
              <span className="text-right text-meta text-muted-foreground">Falhas</span>
              <span className="text-right text-meta text-muted-foreground">Progresso</span>
              <span className="sr-only">Ações</span>
            </div>

            {firstLoad && (
              <div className="divide-y divide-border/70" aria-label="Carregando campanhas">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-2 px-4 py-4">
                    <Skeleton className="h-4 w-56 max-w-full" />
                    <Skeleton className="h-3 w-40 max-w-full" />
                  </div>
                ))}
              </div>
            )}

            {!firstLoad && rows.length === 0 && (
              <EmptyState
                icon={<Megaphone />}
                title={
                  all.length === 0
                    ? "Nenhuma campanha ainda"
                    : "Nenhuma campanha corresponde aos filtros"
                }
                description={
                  all.length === 0
                    ? "Escolha o canal, o público e a mensagem do primeiro envio."
                    : "Ajuste a busca ou o status para ver outras campanhas."
                }
                action={
                  all.length === 0 ? (
                    <Button onClick={openNewCampaign}>
                      <Plus /> Nova campanha
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch("");
                        setStatus("todos");
                      }}
                    >
                      Limpar filtros
                    </Button>
                  )
                }
              />
            )}

            {!firstLoad && rows.length > 0 && (
              <ul>
                {rows.map((campaign) => (
                  <CampaignRow
                    key={`${campaign.channel}-${campaign.id}`}
                    campaign={campaign}
                    cancelPending={cancel.isPending}
                    resumePending={resume.isPending || resumeEmail.isPending}
                    onCancel={async () => {
                      const confirmed = await requestConfirmation({
                        title: "Cancelar o envio desta campanha?",
                        description: `Os envios ainda não feitos de "${campaign.name}" serão cancelados e a campanha não poderá ser retomada. O que já foi enviado não é desfeito.`,
                        confirmLabel: "Cancelar envio",
                        cancelLabel: "Manter campanha",
                        destructive: true,
                      });
                      if (confirmed) cancel.mutate(campaign.id);
                    }}
                    onResume={async () => {
                      if (campaign.channel === "sms") {
                        resume.mutate(campaign.id);
                        return;
                      }
                      const confirmed = await requestConfirmation({
                        title: `Retomar “${campaign.name}”?`,
                        description: `Os e-mails restantes serão enviados imediatamente. ${EMAIL_CAMPAIGN_RESEND_NOTE}`,
                        confirmLabel: "Retomar campanha",
                      });
                      if (confirmed) resumeEmail.mutate(campaign.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </HomeCard>

      <ChannelCampaignComposer
        open={composerOpen}
        onOpenChange={setComposerOpen}
        initialChannel={initialChannel}
        initialDraftId={activeDraftId}
        initialAudienceId={initialAudienceId}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["sms-scheduled-campaigns"] });
          queryClient.invalidateQueries({ queryKey: ["email-campaigns"] });
          queryClient.invalidateQueries({ queryKey: ["call-queue"] });
          queryClient.invalidateQueries({ queryKey: ["campaign-drafts"] });
        }}
      />
      <IndividualSmsDialog open={individualOpen} onOpenChange={setIndividualOpen} />
    </>
  );
}

const ROW_GRID =
  "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,6rem)_minmax(0,6rem)_minmax(0,6rem)_minmax(0,13rem)] xl:items-center xl:gap-4 px-4";

function CampaignRow({
  campaign,
  cancelPending,
  resumePending,
  onCancel,
  onResume,
}: {
  campaign: Campaign;
  cancelPending: boolean;
  resumePending: boolean;
  onCancel: () => void;
  onResume: () => void;
}) {
  const total = Number(campaign.total_count ?? 0);
  const sentCount = Number(campaign.sent_count ?? 0);
  const repeated = Number(campaign.deduplicated_count ?? 0);
  const isVoice = campaign.channel === "voice";
  const done = isVoice
    ? Number(campaign.finished_count ?? 0)
    : sentCount + repeated + Number(campaign.failed_count ?? 0);
  const hasPlannedTotal = campaign.has_planned_total ?? total > 0;
  const progress =
    hasPlannedTotal && total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : "—";
  const operation = getChannelOperationState(campaign.status, campaign.channel);
  const reason =
    campaignStopReason(campaign.status, campaign.last_error, campaign.updated_at) ??
    campaign.blocked_reason ??
    null;
  const unresolved = Number(campaign.unresolved_count ?? 0);
  const pausedForBalance = campaign.channel === "sms" && campaign.status === "pausada";
  const when = campaign.date_is_creation
    ? `criada em ${new Date(campaign.scheduled_at).toLocaleDateString("pt-BR")}`
    : new Date(campaign.scheduled_at).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      });
  const meta = [
    CHANNEL_LABEL[campaign.channel],
    `${num(total)} ${total === 1 ? "destinatário" : "destinatários"}`,
    when,
    isVoice ? `${num(Number(campaign.completed_count ?? 0))} concluídas` : null,
    repeated > 0 ? `${num(repeated)} repetidos ignorados` : null,
  ].filter(Boolean);

  const status = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className={cn("shrink-0", operation.tone)}>
        {operation.label}
      </Badge>
      <CampaignBlockedBadge reason={campaign.blocked_reason} />
      {unresolved > 0 ? (
        <Badge
          variant="outline"
          className="shrink-0 border-warning/40 text-warning"
          title="Destinatários sem cadastro, com telefone inválido ou sem consentimento. Veja o motivo no relatório."
        >
          {num(unresolved)} não enviados
        </Badge>
      ) : null}
    </div>
  );

  return (
    <li
      className={cn(
        ROW_GRID,
        "flex flex-col gap-2.5 border-b border-border/70 py-3.5 last:border-b-0",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3 xl:block">
          <p className="min-w-0 truncate text-body font-medium">
            {campaign.name || "Campanha sem nome"}
          </p>
          <div className="shrink-0 xl:hidden">{status}</div>
        </div>
        <p className="mt-0.5 text-meta text-muted-foreground">{meta.join(" · ")}</p>
        {reason ? (
          <p className="mt-1 text-meta text-foreground/80">
            <span className="font-medium">Motivo:</span> {reason}
          </p>
        ) : null}
      </div>
      <div className="hidden xl:block">{status}</div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 xl:contents">
        <CampaignMetric label="Enviados" value={num(sentCount)} />
        <CampaignMetric label="Falhas" value={num(campaign.failed_count ?? 0)} />
        <CampaignMetric label="Progresso" value={progress} />
      </dl>
      <div className="flex flex-wrap gap-2 xl:justify-end">
        {campaign.has_report === false ? null : (
          <Button size="sm" variant="outline" asChild>
            <Link to="/campanhas/$campaignId/relatorio" params={{ campaignId: campaign.id }}>
              Relatório
            </Link>
          </Button>
        )}
        {campaign.resumable && (campaign.channel === "sms" || campaign.channel === "email") ? (
          <Button size="sm" variant="outline" disabled={resumePending} onClick={onResume}>
            Retomar
          </Button>
        ) : null}
        {pausedForBalance ? (
          <Button size="sm" variant="ghost" asChild>
            <Link to="/plano-e-creditos">Ver saldo</Link>
          </Button>
        ) : null}
        {campaign.cancellable ? (
          <Button size="sm" variant="ghost" disabled={cancelPending} onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** "21/10/2026" → ISO at noon UTC (keeps the same calendar day in Brazil). */
function parsePtBrDate(value: string | null | undefined): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? "");
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}T12:00:00.000Z`;
}

function CampaignMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 text-meta xl:block xl:text-right">
      <dt className="text-muted-foreground xl:sr-only">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground xl:text-body">{value}</dd>
    </div>
  );
}
