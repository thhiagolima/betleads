import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BarChart3, Plus, RotateCw, Search, Send, Trash2, Workflow } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { ChannelCampaignComposer } from "@/components/campaigns/channel-campaign-composer";
import { ChannelObservabilityPanel } from "@/components/campaigns/channel-observability-panel";
import { IndividualSmsDialog } from "@/components/campaigns/individual-sms-dialog";
import { requestConfirmation } from "@/components/system-dialog-host";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { PageHeader } from "@/components/ui-premium/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import {
  campaignStopReason,
  getChannelOperationState,
  groupVoiceQueueItems,
  isFinishedCampaignStatus,
  type VoiceQueueItem,
} from "@/lib/channel-operation-state";
import {
  cancelScheduledSmsCampaign,
  listScheduledSmsCampaigns,
  resumeSmsCampaign,
} from "@/lib/sms.functions";
import { listEmailCampaigns } from "@/lib/email.functions";
import { CampaignBlockedBadge } from "@/components/house-config/campaign-blocked-badge";
import { listCallQueue } from "@/lib/calls.functions";
import { deleteCampaignDraft, listCampaignDrafts } from "@/lib/campaign-drafts.functions";

type CampaignStatus = "todos" | "agendadas" | "enviando" | "finalizadas";
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
      setInitialAudienceId(params.get("audience") === "system:all-leads" ? "system:all-leads" : "");
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
  const rows = all.filter((campaign) => {
    const statusMatches =
      status === "todos" ||
      (status === "agendadas" && ["agendada", "scheduled"].includes(campaign.status)) ||
      (status === "enviando" && campaign.status === "enviando") ||
      (status === "finalizadas" && isFinishedCampaignStatus(campaign.status));
    return (
      statusMatches &&
      (!normalizedSearch ||
        String(campaign.name ?? "")
          .toLowerCase()
          .includes(normalizedSearch))
    );
  });
  const sent = all.reduce((sum, campaign) => sum + Number(campaign.sent_count ?? 0), 0);
  const failed = all.reduce((sum, campaign) => sum + Number(campaign.failed_count ?? 0), 0);
  const queued = all.filter((campaign) =>
    ["agendada", "enviando"].includes(campaign.status),
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        subtitle="Crie, acompanhe e agende disparos para os seus públicos salvos."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/resultados">
                <BarChart3 className="mr-2 h-4 w-4" />
                Resultados
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/automacoes">
                <Workflow className="mr-2 h-4 w-4" />
                Automações
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" /> Criar
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setActiveDraftId(null);
                    setInitialAudienceId("");
                    setInitialChannel("sms");
                    setComposerOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" /> Campanha
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIndividualOpen(true)}>
                  <Send className="mr-2 h-4 w-4" /> Envio individual / teste
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/automacoes">
                    <Workflow className="mr-2 h-4 w-4" /> Automação
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {(drafts.data?.items?.length ?? 0) > 0 && (
        <Card className="border-primary/25 bg-primary/[0.03]">
          <CardContent className="p-0">
            <div className="border-b border-border/60 px-4 py-3">
              <h2 className="text-section">Rascunhos</h2>
              <p className="text-xs text-muted-foreground">
                Campanhas salvas automaticamente e disponíveis para continuar.
              </p>
            </div>
            {(drafts.data!.items as DraftSummary[]).map((draft) => (
              <div
                key={draft.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3 last:border-0"
              >
                <div>
                  <p className="font-medium">{draft.name || "Campanha sem nome"}</p>
                  <p className="text-xs text-muted-foreground">
                    {draft.channel === "email"
                      ? "E-mail"
                      : draft.channel === "voice"
                        ? "Voz"
                        : "SMS"}
                    {" · "}editado em {new Date(draft.updatedAt).toLocaleString("pt-BR")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setActiveDraftId(draft.id);
                      setInitialChannel(draft.channel);
                      setComposerOpen(true);
                    }}
                  >
                    Continuar edição
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Excluir rascunho ${draft.name || "sem nome"}`}
                    disabled={removeDraft.isPending}
                    onClick={async () => {
                      const confirmed = await requestConfirmation({
                        title: "Excluir rascunho?",
                        description: `O rascunho "${draft.name || "Campanha sem nome"}" será apagado e não poderá ser recuperado.`,
                        confirmLabel: "Excluir rascunho",
                        destructive: true,
                      });
                      if (confirmed) removeDraft.mutate(draft.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Enviados" value={num(sent)} hint="nas campanhas listadas" />
        <MetricCard label="Falhas" value={num(failed)} hint="rejeitados ou inválidos" />
        <MetricCard label="Em envio" value={num(queued)} hint="agendadas ou processando" />
      </div>
      <ChannelObservabilityPanel />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-border/70 bg-card/60 p-1">
          {(["todos", "agendadas", "enviando", "finalizadas"] as CampaignStatus[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={status === value ? "default" : "ghost"}
              onClick={() => setStatus(value)}
              className="capitalize"
            >
              {value}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            placeholder="Buscar campanha..."
          />
        </div>
      </div>
      <Card
        className="relative overflow-hidden border-border/70 bg-card/70"
        aria-busy={campaigns.isFetching || emailCampaigns.isFetching}
      >
        {campaigns.isFetching && !campaigns.isLoading && (
          <div
            className="absolute inset-x-0 top-0 z-10 flex items-center justify-center border-b border-primary/20 bg-primary/10 px-3 py-1.5 text-xs text-primary"
            role="status"
          >
            <RotateCw className="mr-2 h-3.5 w-3.5 animate-spin" />
            Atualizando campanhas...
          </div>
        )}
        <CardContent
          className={cn(
            "p-0",
            (campaigns.isFetching || emailCampaigns.isFetching) &&
              !(campaigns.isLoading || emailCampaigns.isLoading) &&
              "opacity-60 transition-opacity",
          )}
        >
          {campaigns.isLoading && (
            <p className="p-6 text-sm text-muted-foreground">Carregando campanhas…</p>
          )}
          {!campaigns.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
              <div>
                <p className="font-medium">
                  {all.length === 0
                    ? "Nenhuma campanha criada ainda"
                    : "Nenhuma campanha corresponde aos filtros"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {all.length === 0
                    ? "Comece escolhendo o canal, a audiência e o conteúdo do primeiro disparo."
                    : "Ajuste a busca ou o status para visualizar outras campanhas."}
                </p>
              </div>
              {all.length === 0 ? (
                <Button
                  onClick={() => {
                    setInitialChannel("sms");
                    setActiveDraftId(null);
                    setInitialAudienceId("");
                    setComposerOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Criar primeira campanha
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
              )}
            </div>
          )}
          {rows.map((campaign) => {
            const total = Number(campaign.total_count ?? 0);
            const delivered = Number(campaign.sent_count ?? 0);
            const deduplicated = Number(campaign.deduplicated_count ?? 0);
            const isVoice = campaign.channel === "voice";
            const completed = isVoice
              ? Number(campaign.finished_count ?? 0)
              : delivered + deduplicated + Number(campaign.failed_count ?? 0);
            const hasPlannedTotal = campaign.has_planned_total ?? total > 0;
            const operation = getChannelOperationState(campaign.status, campaign.channel);
            const reason =
              campaignStopReason(campaign.status, campaign.last_error, campaign.updated_at) ??
              campaign.blocked_reason ??
              null;
            return (
              <div
                key={campaign.id}
                className="grid gap-3 border-b border-border/50 px-4 py-3 last:border-0 md:grid-cols-[minmax(220px,1fr)_100px_100px_80px_90px_150px] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{campaign.name}</p>
                    <Badge variant="outline" className={operation.tone}>
                      {operation.label}
                    </Badge>
                    <CampaignBlockedBadge reason={campaign.blocked_reason} />
                    {Number(campaign.unresolved_count ?? 0) > 0 ? (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-warning/40 text-warning"
                        title="Destinatários sem cadastro, com telefone inválido ou sem consentimento. Veja o motivo no relatório."
                      >
                        {num(Number(campaign.unresolved_count))} não enviados
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {campaign.channel === "sms"
                      ? "SMS"
                      : campaign.channel === "email"
                        ? "E-mail"
                        : "Voz"}{" "}
                    · {num(total)} destinatários ·{" "}
                    {campaign.date_is_creation
                      ? `criada em ${new Date(campaign.scheduled_at).toLocaleDateString("pt-BR")}`
                      : new Date(campaign.scheduled_at).toLocaleString("pt-BR")}
                  </p>
                  {reason ? (
                    <p className="mt-1 text-xs text-foreground/80">
                      <span className="font-medium">Motivo:</span> {reason}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">{operation.nextAction}</p>
                </div>
                <CampaignMetric label="Enviados" value={num(delivered)} />
                {isVoice ? (
                  <CampaignMetric
                    label="Concluídas"
                    value={num(Number(campaign.completed_count ?? 0))}
                  />
                ) : (
                  <CampaignMetric label="Deduplicados" value={num(deduplicated)} />
                )}
                <CampaignMetric label="Falhas" value={num(campaign.failed_count ?? 0)} />
                <CampaignMetric
                  label="Progresso"
                  value={
                    hasPlannedTotal && total > 0
                      ? `${Math.min(100, Math.round((completed / total) * 100))}%`
                      : "—"
                  }
                />
                <div className="flex flex-wrap justify-end gap-1">
                  {campaign.has_report === false ? null : (
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        to="/campanhas/$campaignId/relatorio"
                        params={{ campaignId: campaign.id }}
                      >
                        Relatório
                      </Link>
                    </Button>
                  )}
                  {campaign.cancellable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={async () => {
                        const confirmed = await requestConfirmation({
                          title: "Cancelar o envio desta campanha?",
                          description: `Os envios ainda não feitos de "${campaign.name}" serão cancelados e a campanha não poderá ser retomada. O que já foi enviado não é desfeito.`,
                          confirmLabel: "Cancelar envio",
                          cancelLabel: "Manter campanha",
                          destructive: true,
                        });
                        if (confirmed) cancel.mutate(campaign.id);
                      }}
                    >
                      Cancelar envio
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" asChild>
                      <a href={operation.actionTo}>{operation.actionLabel}</a>
                    </Button>
                  )}
                  {campaign.resumable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resume.isPending}
                      onClick={() => resume.mutate(campaign.id)}
                    >
                      Retomar
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
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
    </div>
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
    <div className="text-xs text-muted-foreground">
      {label}
      <strong className="block text-sm text-foreground">{value}</strong>
    </div>
  );
}
