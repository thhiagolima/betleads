import { useMemo, useState } from "react";
import { CHANNEL_IDENTITY } from "@/components/identity/identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Inbox,
  Info,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  convertLegacyJourney,
  deleteJourney,
  getJourneyContactLimits,
  listJourneyOperations,
  listJourneys,
  listLegacyJourneys,
  saveJourneyContactLimits,
  retireLegacyJourney,
  setJourneyExpress,
} from "@/lib/journeys.functions";
import { EXPRESS_JOURNEY_HINT } from "@/lib/journey-express";
import { ENROLLMENT_STATUS_LABELS } from "@/lib/player-journeys";
import { JourneyMapCard } from "@/components/journeys/journey-map-card";
import { useJourneyStatusControl } from "@/components/journeys/journey-status-control";
import { FlowsTab } from "@/components/ligacoes/flows-tab";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { requestConfirmation } from "@/components/system-dialog-host";
import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  JOURNEY_STATUS_LABELS,
  journeyExitReasonLabel,
  journeyInProgress,
  journeyTriggerLabel,
  priorityPauseReasonLabel,
} from "@/components/journeys/journey-editor-config";

// Grade A only: direct conversion_attributions (confirmed first-party click,
// same player, up to 7 days). Operational deposits never appear in journeys.
const ATTRIBUTED_RECOVERY_HINT =
  "Depósitos com clique confirmado no link da jornada, até 7 dias após o clique.";

type Journey = {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "archived";
  trigger_type: string;
  daily_limit: number;
  express?: boolean;
  ends_at?: string | null;
  trigger_config?: Record<string, unknown> | null;
  exit_rules?: Record<string, unknown> | null;
  conflict_family?: string | null;
  journey_priority?: number | null;
  holdout_percent?: number | null;
  journey_steps: Array<{
    id: string;
    position: number;
    step_type: "wait" | "sms" | "email" | "voice" | "end";
    config: Record<string, unknown>;
    is_enabled: boolean;
  }>;
  metrics: {
    eligible?: number;
    byStatus?: Record<string, number>;
    exits?: Record<string, number>;
    recovered?: number;
    sentByChannel?: Record<string, number>;
  };
};
type LegacyJourney = {
  sourceType: "sms_flow" | "email_flow";
  sourceId: string;
  channel: "sms" | "email";
  name: string;
  trigger: string;
  active: boolean;
  updatedAt: string;
  journeyId: string | null;
  journeyStatus: Journey["status"] | null;
};
type OperationItem = {
  id: string;
  status: string;
  current_position: number;
  next_run_at: string | null;
  exit_reason: string | null;
  priority_paused_at: string | null;
  priority_pause_reason: string | null;
  priority_paused_by_journey_name: string | null;
  journeys: { name: string } | null;
  players: { nome: string | null } | null;
};

type HubView = "journeys" | "map" | "queue" | "failures" | "conflicts" | "flows";
const HUB_VIEWS: ReadonlyArray<{ value: HubView; label: string; hash: string }> = [
  { value: "journeys", label: "Jornadas", hash: "jornadas" },
  { value: "map", label: "Mapa", hash: "mapa" },
  { value: "queue", label: "Fila de envio", hash: "fila" },
  { value: "failures", label: "Falhas", hash: "falhas" },
  { value: "conflicts", label: "Conflitos", hash: "conflitos" },
  { value: "flows", label: "Fluxos de voz", hash: "fluxos-de-voz" },
];

function viewFromHash(hash: string): HubView {
  const clean = hash.replace(/^#/, "");
  return HUB_VIEWS.find((item) => item.hash === clean)?.value ?? "journeys";
}

const STATUS_FILTERS = [
  { value: "all", label: "Todas" },
  { value: "active", label: "Ativas" },
  { value: "paused", label: "Pausadas" },
  { value: "draft", label: "Rascunhos" },
] as const;

const STATUS_BADGE: Record<Journey["status"], string> = {
  active: "border-success/20 bg-success/15 text-success",
  paused: "border-warning/20 bg-warning/15 text-warning",
  draft: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
};

const brl = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function JourneysHub() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useServerFn(listJourneys);
  const changeExpress = useServerFn(setJourneyExpress);
  const [expressCandidate, setExpressCandidate] = useState<Journey | null>(null);
  const removeJourney = useServerFn(deleteJourney);
  const operationsFn = useServerFn(listJourneyOperations);
  const legacyFn = useServerFn(listLegacyJourneys);
  const convertFn = useServerFn(convertLegacyJourney);
  const retireFn = useServerFn(retireLegacyJourney);
  const contactLimitsFn = useServerFn(getJourneyContactLimits);
  const saveContactLimitsFn = useServerFn(saveJourneyContactLimits);
  const [filter, setFilter] = useState<"all" | Journey["status"]>("all");
  const [search, setSearch] = useState("");
  // Active tab lives in the URL hash (#jornadas, #mapa, #fila…), pushed to the
  // history so Voltar returns to the previous tab.
  const hash = useLocation({ select: (location) => location.hash });
  const view = viewFromHash(hash);
  const setView = (next: HubView) => {
    void navigate({
      to: "/automacoes",
      hash: HUB_VIEWS.find((item) => item.value === next)?.hash ?? "jornadas",
    });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dailyMessageLimit, setDailyMessageLimit] = useState("");
  const [weeklyMessageLimit, setWeeklyMessageLimit] = useState("");
  const statusControl = useJourneyStatusControl();
  const journeys = useQuery({ queryKey: ["journeys"], queryFn: () => list() });
  const operations = useQuery({
    queryKey: ["journey-operations"],
    queryFn: () => operationsFn(),
    enabled: view === "queue" || view === "failures" || view === "conflicts",
  });
  const contactLimits = useQuery({
    queryKey: ["journey-contact-limits"],
    queryFn: () => contactLimitsFn(),
    enabled: settingsOpen,
  });
  const legacy = useQuery({
    queryKey: ["legacy-journeys"],
    queryFn: () => legacyFn(),
    enabled: Boolean(journeys.data) && view === "journeys",
  });
  const express = useMutation({
    mutationFn: (input: { id: string; express: boolean }) => changeExpress({ data: input }),
    onSuccess: async (result) => {
      setExpressCandidate(null);
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      toast.success(
        result.express
          ? result.requeued > 0
            ? `Envio imediato ligado. ${result.requeued} jogador(es) adiado(s) voltaram para a fila.`
            : "Envio imediato ligado."
          : "Envio imediato desligado.",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeJourney({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      toast.success("Jornada excluída");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const convert = useMutation({
    mutationFn: (input: { sourceType: LegacyJourney["sourceType"]; sourceId: string }) =>
      convertFn({ data: input }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["journeys"] }),
        queryClient.invalidateQueries({ queryKey: ["legacy-journeys"] }),
      ]);
      if (result.warnings.length)
        toast.warning(`Rascunho criado com ${result.warnings.length} aviso(s) para revisão.`);
      else
        toast.success(
          result.alreadyConverted
            ? "Esta automação já foi convertida."
            : "Rascunho convertido com sucesso.",
        );
      navigate({ to: "/jornadas/$journeyId", params: { journeyId: result.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const retire = useMutation({
    mutationFn: (input: { sourceType: LegacyJourney["sourceType"]; sourceId: string }) =>
      retireFn({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["legacy-journeys"] });
      toast.success("Automação legada desativada. A migração foi concluída.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const saveContactLimits = useMutation({
    mutationFn: () =>
      saveContactLimitsFn({
        data: {
          max24h: dailyMessageLimit.trim() ? Number(dailyMessageLimit) : null,
          max7d: weeklyMessageLimit.trim() ? Number(weeklyMessageLimit) : null,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journey-contact-limits"] });
      setSettingsOpen(false);
      toast.success("Limites de contato salvos.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const openContactSettings = async () => {
    const result = await contactLimits.refetch();
    setDailyMessageLimit(result.data?.max24h?.toString() ?? "");
    setWeeklyMessageLimit(result.data?.max7d?.toString() ?? "");
    setSettingsOpen(true);
  };
  const allJourneys = useMemo(
    () => (journeys.data?.journeys ?? []) as Journey[],
    [journeys.data?.journeys],
  );
  const rows = useMemo(
    () =>
      allJourneys.filter(
        (journey) =>
          (filter === "all" || journey.status === filter) &&
          `${journey.name} ${journeyTriggerLabel(journey.trigger_type, journey.trigger_config)}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [allJourneys, filter, search],
  );
  const overview = useMemo(
    () =>
      allJourneys.reduce(
        (total, journey) => {
          const metrics = journey.metrics ?? {};
          total.recovered += Number(metrics.recovered ?? 0);
          total.sent += Object.values(metrics.sentByChannel ?? {}).reduce(
            (sum, value) => sum + Number(value),
            0,
          );
          total.queued += journeyInProgress(metrics.byStatus);
          if (journey.status === "active") total.active += 1;
          return total;
        },
        { recovered: 0, sent: 0, queued: 0, active: 0 },
      ),
    [allJourneys],
  );
  const operationItems = ((operations.data?.items ?? []) as OperationItem[]).filter((item) =>
    view === "failures"
      ? item.status === "failed"
      : view === "conflicts"
        ? item.status === "paused_by_priority"
        : item.status !== "failed" && item.status !== "paused_by_priority",
  );
  const pausedByPriority = Number(operations.data?.summary?.pausedByPriority ?? 0);

  const confirmExpressOff = async (journey: Journey) => {
    const confirmed = await requestConfirmation({
      title: "Desligar o envio imediato?",
      description: `A jornada “${journey.name}” volta a respeitar o intervalo entre jornadas, os limites de mensagens por pessoa e a prioridade. Envios podem passar a ser adiados.`,
      confirmLabel: "Desligar envio imediato",
    });
    if (confirmed) express.mutate({ id: journey.id, express: false });
  };
  const confirmDelete = async (journey: Journey) => {
    const confirmed = await requestConfirmation({
      title: "Excluir jornada?",
      description: `A jornada “${journey.name}” será excluída. Esta ação não pode ser desfeita.`,
      confirmLabel: "Excluir jornada",
      destructive: true,
    });
    if (confirmed) remove.mutate(journey.id);
  };
  const confirmRetire = async (item: LegacyJourney) => {
    const confirmed = await requestConfirmation({
      title: "Desativar a automação legada?",
      description: `A automação de ${item.channel === "sms" ? "SMS" : "e-mail"} “${item.name}” para de enviar agora. Os envios passam a sair só pela jornada convertida, que já está ativa.`,
      confirmLabel: "Desativar legado",
      destructive: true,
    });
    if (confirmed) retire.mutate({ sourceType: item.sourceType, sourceId: item.sourceId });
  };

  return (
    <Page>
      <PageHeader
        subtitle="Jornadas entram por gatilho e seguem jogador a jogador, com SMS, e-mail, voz e esperas."
        actions={
          <Button asChild>
            <Link to="/jornadas/nova">
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Nova jornada
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageTabs
          value={view}
          onValueChange={setView}
          label="Seções de Automações"
          items={HUB_VIEWS.map((item) => ({
            value: item.value,
            label:
              item.value === "conflicts" && pausedByPriority > 0
                ? `${item.label} (${pausedByPriority.toLocaleString("pt-BR")})`
                : item.label,
          }))}
        />
        {view !== "flows" && view !== "map" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void openContactSettings()}>
              Limites de contato
            </Button>
            {view === "journeys" && (
              <Button variant="outline" size="sm" onClick={() => setInfoOpen(true)}>
                Como contamos
              </Button>
            )}
          </div>
        )}
      </div>
      {view === "journeys" && (
        <>
          {/* Period selector (Hoje/7/30 dias) hidden: list_journey_metrics has no
              date filter, so totals below are all-time. Restore with REP-02. */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiCard
              title="Recuperado pelo CRM"
              value={brl(overview.recovered)}
              detail={ATTRIBUTED_RECOVERY_HINT}
            />
            <KpiCard
              title="Mensagens enviadas"
              value={overview.sent.toLocaleString("pt-BR")}
              detail="Desde o início, todos os canais"
            />
            <KpiCard
              title="Em andamento"
              value={overview.queued.toLocaleString("pt-BR")}
              detail="Jogadores dentro das jornadas agora"
            />
            <KpiCard
              title="Jornadas ativas"
              value={overview.active.toLocaleString("pt-BR")}
              detail={`de ${allJourneys.length.toLocaleString("pt-BR")} jornada(s)`}
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              role="group"
              aria-label="Filtrar por status"
              className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl border border-border bg-card p-[3px] [scrollbar-width:none]"
            >
              {STATUS_FILTERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={filter === item.value}
                  onClick={() => setFilter(item.value)}
                  className={
                    filter === item.value
                      ? "h-9 shrink-0 rounded-lg bg-secondary px-3 text-[13px] font-medium text-foreground"
                      : "h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="relative sm:w-72">
              <Label htmlFor="journey-search" className="sr-only">
                Buscar jornada
              </Label>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="journey-search"
                className="h-10 pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nome ou gatilho"
              />
            </div>
          </div>
          <HomeCard className="overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <h2 className="text-section">Jornadas</h2>
              <span className="text-meta text-muted-foreground">
                {rows.length.toLocaleString("pt-BR")} encontrada(s)
              </span>
            </div>
            {journeys.isLoading ? (
              <p className="py-8 text-center text-body text-muted-foreground">
                Carregando jornadas…
              </p>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Inbox />}
                title={allJourneys.length ? "Nenhuma jornada nesta visão" : "Nenhuma jornada ainda"}
                description={
                  allJourneys.length
                    ? "Mude o filtro ou a busca para ver outras jornadas."
                    : "Crie a primeira jornada para falar com os jogadores no momento certo."
                }
                action={
                  allJourneys.length ? undefined : (
                    <Button asChild size="sm">
                      <Link to="/jornadas/nova">
                        <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Nova jornada
                      </Link>
                    </Button>
                  )
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((journey) => (
                  <JourneyRow
                    key={journey.id}
                    journey={journey}
                    busy={statusControl.isPending}
                    expressBusy={express.isPending}
                    removeBusy={remove.isPending}
                    onActivate={() => statusControl.requestActivate(journey)}
                    onPause={() =>
                      statusControl.requestPause({
                        id: journey.id,
                        name: journey.name,
                        inProgress: journeyInProgress(journey.metrics?.byStatus),
                      })
                    }
                    onExpress={() =>
                      journey.express
                        ? void confirmExpressOff(journey)
                        : setExpressCandidate(journey)
                    }
                    onDelete={() => void confirmDelete(journey)}
                  />
                ))}
              </ul>
            )}
          </HomeCard>
        </>
      )}
      {(view === "queue" || view === "failures" || view === "conflicts") && (
        <HomeCard className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-section">
                {view === "queue" ? "Fila de envio" : view === "conflicts" ? "Conflitos" : "Falhas"}
              </h2>
              <span className="text-meta text-muted-foreground">
                {operationItems.length.toLocaleString("pt-BR")} registro(s)
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {view === "queue"
                ? "Jogadores dentro de uma jornada, aguardando a próxima etapa."
                : view === "conflicts"
                  ? "Jogadores pausados porque outra jornada de maior prioridade está falando com eles."
                  : "Jogadores cujo envio falhou depois de todas as tentativas."}
            </p>
          </div>
          {operations.isLoading ? (
            <p className="py-8 text-center text-body text-muted-foreground">Carregando…</p>
          ) : operationItems.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title={
                view === "queue"
                  ? "Fila de envio vazia"
                  : view === "conflicts"
                    ? "Nenhum conflito agora"
                    : "Nenhuma falha registrada"
              }
              description={
                view === "queue"
                  ? "Nenhum jogador aguardando envio nas jornadas."
                  : view === "conflicts"
                    ? "Nenhum jogador pausado por prioridade entre jornadas."
                    : "Nenhum envio de jornada falhou."
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {operationItems.map((item) => (
                <OperationRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </HomeCard>
      )}
      {view === "flows" && <FlowsTab />}
      {view === "map" && (
        <JourneyMapCard
          journeys={allJourneys.map((journey) => ({
            ...journey,
            inProgress: journeyInProgress(journey.metrics?.byStatus),
          }))}
        />
      )}
      {view === "journeys" && ((legacy.data?.items ?? []).length > 0 || legacy.isLoading) && (
        <HomeCard className="overflow-hidden border-dashed">
          <div id="legado" className="border-b border-border px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section">Automações legadas</h2>
              <Badge variant="outline">Compatibilidade temporária</Badge>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Converta, revise o rascunho, ative a jornada e só então desative a origem. Novas
              automações são criadas sempre como jornadas.
            </p>
          </div>
          {legacy.isLoading ? (
            <p className="px-4 py-6 text-body text-muted-foreground sm:px-5">
              Carregando itens legados…
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(legacy.data?.items ?? []).map((item: LegacyJourney) => (
                <li
                  key={`${item.sourceType}:${item.sourceId}`}
                  className="flex flex-col gap-3 px-4 py-3 sm:px-5 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.channel === "sms" ? (
                        <MessageSquare
                          className="h-4 w-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : (
                        <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      )}
                      <p className="font-medium">{item.name}</p>
                      <Badge
                        variant="outline"
                        className={item.active ? STATUS_BADGE.active : STATUS_BADGE.draft}
                      >
                        {item.active ? "Ativa" : "Desativada"}
                      </Badge>
                      {item.journeyId && (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">
                          {item.active ? "Convertida" : "Migração concluída"}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      {item.channel === "sms" ? "SMS" : "E-mail"} · entrada {item.trigger}
                    </p>
                  </div>
                  {item.journeyId ? (
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline" className="h-11 md:h-9">
                        <Link to="/jornadas/$journeyId" params={{ journeyId: item.journeyId }}>
                          Abrir jornada
                        </Link>
                      </Button>
                      {item.active && item.journeyStatus === "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-11 text-destructive hover:text-destructive md:h-9"
                          disabled={retire.isPending}
                          onClick={() => void confirmRetire(item)}
                        >
                          Desativar legado
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11 md:h-9"
                      disabled={convert.isPending}
                      onClick={() =>
                        convert.mutate({ sourceType: item.sourceType, sourceId: item.sourceId })
                      }
                    >
                      Converter em jornada
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </HomeCard>
      )}
      {statusControl.dialogs}
      <Dialog
        open={expressCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !express.isPending) setExpressCandidate(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-warning" aria-hidden="true" /> Ligar envio imediato?
            </DialogTitle>
            <DialogDescription>
              {expressCandidate ? `Jornada “${expressCandidate.name}”.` : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{EXPRESS_JOURNEY_HINT}</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Passa na frente das outras jornadas na fila de envio.</li>
              <li>Continua respeitando o limite diário da própria jornada e a reentrada.</li>
              <li>
                Jogadores desta jornada que foram adiados pelo intervalo entre jornadas ou por
                limite global voltam para a fila agora.
              </li>
            </ul>
            <p>Use só em jornadas urgentes, como saque pago ou PIX gerado.</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={express.isPending}
              onClick={() => setExpressCandidate(null)}
            >
              Cancelar
            </Button>
            <Button
              disabled={express.isPending || !expressCandidate}
              onClick={() =>
                expressCandidate && express.mutate({ id: expressCandidate.id, express: true })
              }
            >
              <Zap className="mr-1 h-4 w-4" aria-hidden="true" /> Ligar envio imediato
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Limite de mensagens por pessoa</DialogTitle>
            <DialogDescription>
              Vale para todas as jornadas, em todos os canais. Em branco, não há limite.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-limit-24h">Máximo em 24 h</Label>
              <Input
                id="contact-limit-24h"
                inputMode="numeric"
                placeholder="Sem limite"
                value={dailyMessageLimit}
                onChange={(event) => setDailyMessageLimit(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-limit-7d">Máximo em 7 dias</Label>
              <Input
                id="contact-limit-7d"
                inputMode="numeric"
                placeholder="Sem limite"
                value={weeklyMessageLimit}
                onChange={(event) => setWeeklyMessageLimit(event.target.value)}
              />
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            A contagem inclui os SMS e e-mails já enviados pela casa em cada canal. Mensagens ainda
            agendadas não entram no limite.
          </p>
          <DialogFooter>
            <Button
              disabled={saveContactLimits.isPending}
              onClick={() => saveContactLimits.mutate()}
            >
              {saveContactLimits.isPending ? "Salvando…" : "Salvar limites"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Como a conta é feita</DialogTitle>
            <DialogDescription>
              O que entra em Recuperado pelo CRM e o que fica de fora.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p className="font-semibold text-foreground">
              Conta como recuperado o depósito do mesmo jogador feito em até 7 dias depois de um
              clique confirmado no link da jornada.
            </p>
            <p>
              Cada depósito é atribuído a apenas uma mensagem: a do último clique rastreado.
              Depósitos entre o 8º e o 14º dia ficam registrados como assistidos e não entram no
              recuperado.
            </p>
            <p>
              Depósitos sem clique confirmado no link da jornada são operacionais e não aparecem nas
              telas de jornadas.
            </p>
            <p>
              Quem deposita em qualquer etapa sai da jornada na hora. Jogadores que pediram para
              sair não voltam a receber comunicações.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function JourneyRow({
  journey,
  busy,
  expressBusy,
  removeBusy,
  onActivate,
  onPause,
  onExpress,
  onDelete,
}: {
  journey: Journey;
  busy: boolean;
  expressBusy: boolean;
  removeBusy: boolean;
  onActivate: () => void;
  onPause: () => void;
  onExpress: () => void;
  onDelete: () => void;
}) {
  const steps = journey.journey_steps
    .filter((step) => step.is_enabled && step.step_type !== "end")
    .sort((a, b) => a.position - b.position);
  const metrics = journey.metrics ?? {};
  const inProgress = journeyInProgress(metrics.byStatus);
  const finished = Number(metrics.byStatus?.completed ?? 0) + Number(metrics.byStatus?.exited ?? 0);
  const sent = Object.values(metrics.sentByChannel ?? {}).reduce(
    (total, value) => total + Number(value),
    0,
  );
  const active = journey.status === "active";
  return (
    <li className="grid gap-4 px-4 py-4 sm:px-5 xl:grid-cols-[minmax(16rem,1fr)_auto_auto] xl:items-center xl:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/jornadas/$journeyId"
            params={{ journeyId: journey.id }}
            className="truncate font-semibold hover:underline"
          >
            {journey.name}
          </Link>
          <Badge variant="outline" className={STATUS_BADGE[journey.status]}>
            {JOURNEY_STATUS_LABELS[journey.status]}
          </Badge>
          {journey.ends_at && (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              {Date.parse(journey.ends_at) <= Date.now() ? "Encerrada em " : "Encerra em "}
              {new Date(journey.ends_at).toLocaleDateString("pt-BR", {
                timeZone: "America/Sao_Paulo",
              })}
            </Badge>
          )}
          {journey.express && (
            <Badge
              variant="outline"
              className="gap-1 border-warning/30 bg-warning/15 text-warning"
              title={EXPRESS_JOURNEY_HINT}
            >
              <Zap className="h-3 w-3" aria-hidden="true" /> Envio imediato
            </Badge>
          )}
        </div>
        <p className="mt-1 truncate text-[12.5px] text-muted-foreground">
          {journeyTriggerLabel(journey.trigger_type, journey.trigger_config)}
        </p>
        <JourneyStepSummary steps={steps} />
      </div>
      <div className="grid grid-cols-2 gap-x-7 gap-y-3 sm:grid-cols-4">
        <JourneyMetric
          label="Em andamento"
          hint="Jogadores dentro da jornada agora: aguardando a próxima etapa, a janela de envio ou pausados por prioridade."
          value={inProgress.toLocaleString("pt-BR")}
        />
        <JourneyMetric
          label="Concluíram"
          hint="Jogadores que terminaram a jornada ou saíram dela (por exemplo, ao depositar)."
          value={finished.toLocaleString("pt-BR")}
        />
        <JourneyMetric label="Enviados" value={sent.toLocaleString("pt-BR")} />
        <JourneyMetric
          label="Recuperado pelo CRM"
          hint={ATTRIBUTED_RECOVERY_HINT}
          value={brl(Number(metrics.recovered ?? 0))}
          accent
        />
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 sm:flex xl:justify-end">
        {active ? (
          <Button
            variant="outline"
            className="h-11 md:h-9"
            disabled={busy}
            onClick={onPause}
            aria-label={`Pausar a jornada ${journey.name}`}
          >
            <Pause className="mr-1 h-4 w-4" aria-hidden="true" /> Pausar
          </Button>
        ) : (
          <Button
            className="h-11 md:h-9"
            disabled={busy || journey.status === "archived"}
            onClick={onActivate}
            aria-label={`Ativar a jornada ${journey.name}`}
          >
            <Play className="mr-1 h-4 w-4" aria-hidden="true" /> Ativar
          </Button>
        )}
        <Button asChild variant="outline" className="h-11 md:h-9">
          <Link to="/jornadas/$journeyId/relatorio" params={{ journeyId: journey.id }}>
            Relatório
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              variant="outline"
              label={`Mais ações da jornada ${journey.name}`}
              icon={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem asChild className="min-h-11 md:min-h-9">
              <Link to="/jornadas/$journeyId" params={{ journeyId: journey.id }}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" /> Editar
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 md:min-h-9"
              disabled={expressBusy}
              onSelect={onExpress}
            >
              <Zap
                className={journey.express ? "mr-2 h-4 w-4 text-warning" : "mr-2 h-4 w-4"}
                aria-hidden="true"
              />
              {journey.express ? "Desligar envio imediato" : "Ligar envio imediato"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-11 text-destructive focus:text-destructive md:min-h-9"
              disabled={removeBusy || active}
              onSelect={onDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {active ? "Excluir (pause antes)" : "Excluir"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function OperationRow({ item }: { item: OperationItem }) {
  const reason = journeyExitReasonLabel(item.exit_reason);
  const statusLabel = ENROLLMENT_STATUS_LABELS[item.status];
  const pauseReason = priorityPauseReasonLabel(item.priority_pause_reason);
  return (
    <li className="px-4 py-3 text-[13.5px] sm:px-5">
      <p className="font-medium">
        {item.players?.nome ?? "Jogador"}
        <span className="font-normal text-muted-foreground">
          {" "}
          · {item.journeys?.name ?? "Jornada"}
        </span>
      </p>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
        Etapa {item.current_position + 1}
        {statusLabel && item.status !== "failed" && item.status !== "paused_by_priority"
          ? ` · ${statusLabel}`
          : ""}
        {item.next_run_at ? ` · próximo envio ${dateTime(item.next_run_at)}` : ""}
      </p>
      {reason && (
        <p
          className={`mt-0.5 text-[12.5px] ${item.status === "failed" ? "text-danger" : "text-muted-foreground"}`}
        >
          {item.status === "failed" ? "Motivo da falha: " : "Motivo: "}
          {reason}
        </p>
      )}
      {item.status === "paused_by_priority" && (
        <p className="mt-0.5 text-[12.5px] text-warning">
          Pausada por prioridade
          {item.priority_paused_by_journey_name
            ? `: “${item.priority_paused_by_journey_name}” tem prioridade`
            : ", aguardando o fim da jornada com prioridade"}
          {pauseReason ? ` (${pauseReason})` : ""}
          {item.priority_paused_at ? ` · desde ${dateTime(item.priority_paused_at)}` : ""}
        </p>
      )}
    </li>
  );
}

const channelNames = { wait: "espera", sms: "SMS", email: "e-mail", voice: "voz", end: "fim" };
// Identity colours: the same channel colour as campaigns and the player's history.
const channelStyles = {
  wait: "",
  sms: `${CHANNEL_IDENTITY.sms.border} ${CHANNEL_IDENTITY.sms.text}`,
  email: `${CHANNEL_IDENTITY.email.border} ${CHANNEL_IDENTITY.email.text}`,
  voice: `${CHANNEL_IDENTITY.voice.border} ${CHANNEL_IDENTITY.voice.text}`,
  end: "",
};
const channelDots = {
  wait: "",
  sms: CHANNEL_IDENTITY.sms.dot,
  email: CHANNEL_IDENTITY.email.dot,
  voice: CHANNEL_IDENTITY.voice.dot,
  end: "",
};

const STEP_SEQUENCE_MAX = 10;

/**
 * One-line summary of the step sequence: "7 SMS · 6 dias" plus a compact
 * dot sequence, instead of one chip per step that wrapped into a tall column.
 */
function JourneyStepSummary({ steps }: { steps: Journey["journey_steps"] }) {
  const sends = steps.filter((step) => step.step_type !== "wait");
  if (sends.length === 0) {
    return <p className="mt-2 text-[12.5px] text-muted-foreground">Sem etapas configuradas</p>;
  }
  const byChannel = sends.reduce<Record<string, number>>((acc, step) => {
    acc[step.step_type] = (acc[step.step_type] ?? 0) + 1;
    return acc;
  }, {});
  const totalWaitSeconds = steps
    .filter((step) => step.step_type === "wait")
    .reduce((total, step) => total + Number(step.config.delay_seconds ?? 0), 0);
  const sequence = steps.slice(0, STEP_SEQUENCE_MAX);
  const hidden = steps.length - sequence.length;
  const fullSequence = steps
    .map((step) =>
      step.step_type === "wait"
        ? formatWait(Number(step.config.delay_seconds ?? 0))
        : channelNames[step.step_type],
    )
    .join(" → ");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.entries(byChannel).map(([channel, count]) => (
          <span
            key={channel}
            className={`rounded-md border px-2 py-0.5 text-meta font-semibold ${channelStyles[channel as keyof typeof channelStyles]}`}
          >
            {count} {channelNames[channel as keyof typeof channelNames]}
          </span>
        ))}
        {totalWaitSeconds > 0 && (
          <span className="text-xs text-muted-foreground">em {formatWait(totalWaitSeconds)}</span>
        )}
      </div>
      <div
        className="flex items-center gap-1"
        role="img"
        aria-label={`Sequência: ${fullSequence}`}
        title={fullSequence}
      >
        {sequence.map((step) =>
          step.step_type === "wait" ? (
            <span key={step.id} className="h-px w-3 bg-border" aria-hidden="true" />
          ) : (
            <span
              key={step.id}
              className={`h-2 w-2 rounded-full ${channelDots[step.step_type]}`}
              aria-hidden="true"
            />
          ),
        )}
        {hidden > 0 && <span className="text-xs text-muted-foreground">+{hidden}</span>}
      </div>
    </div>
  );
}

function formatWait(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(".", ",")} h`;
  }
  const days = seconds / 86400;
  return `${Number.isInteger(days) ? days : days.toFixed(1).replace(".", ",")} d`;
}

function JourneyMetric({
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
    <div className="sm:text-right">
      <p className="flex items-center gap-1 text-meta text-muted-foreground sm:justify-end">
        {label}
        {hint ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Sobre ${label}: ${hint}`}
                  className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs whitespace-normal text-left">
                {hint}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </p>
      <p className={`mt-0.5 font-semibold tabular-nums ${accent ? "text-success" : ""}`}>{value}</p>
    </div>
  );
}
