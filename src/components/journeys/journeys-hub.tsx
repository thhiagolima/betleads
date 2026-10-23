import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  CircleDollarSign,
  Info,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Route,
  Search,
  Send,
  UsersRound,
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
  getJourneyActivationEstimate,
  setJourneyStatus,
} from "@/lib/journeys.functions";
import { EXPRESS_JOURNEY_HINT } from "@/lib/journey-express";
import { JourneyMapCard } from "@/components/journeys/journey-map-card";
import { requestConfirmation } from "@/components/system-dialog-host";
import {
  activationAsksEntryScope,
  defaultEntryScope,
  type JourneyEntryScope,
} from "@/lib/journey-policy";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TRIGGER_NAMES } from "@/lib/triggers";
import { journeyTriggerLabel } from "@/components/journeys/journey-editor-config";

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

export function JourneysHub() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useServerFn(listJourneys);
  const changeStatus = useServerFn(setJourneyStatus);
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
  const [view, setView] = useState<"journeys" | "map" | "queue" | "conflicts" | "failures">(
    "journeys",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dailyMessageLimit, setDailyMessageLimit] = useState("");
  const [weeklyMessageLimit, setWeeklyMessageLimit] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [entryMode, setEntryMode] = useState<"event" | "inactivity" | "manual">("event");
  const [newTrigger, setNewTrigger] = useState("lead_cadastrado");
  const [inactivityField, setInactivityField] = useState("ultimo_login");
  const [inactivityHours, setInactivityHours] = useState(168);
  const create = () => {
    window.sessionStorage.setItem(
      "journey-draft",
      JSON.stringify({
        name: newName,
        trigger:
          entryMode === "manual"
            ? "manual"
            : entryMode === "inactivity"
              ? "inactivity"
              : newTrigger,
        entryMode,
        triggerConfig:
          entryMode === "inactivity" ? { field: inactivityField, hours: inactivityHours } : {},
      }),
    );
    setNewOpen(false);
    navigate({ to: "/jornadas/nova" });
  };
  const journeys = useQuery({ queryKey: ["journeys"], queryFn: () => list() });
  const operations = useQuery({
    queryKey: ["journey-operations"],
    queryFn: () => operationsFn(),
    enabled: view !== "journeys" && view !== "map",
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
  const [pauseCandidate, setPauseCandidate] = useState<{
    id: string;
    name: string;
    inProgress: number;
  } | null>(null);
  const [closeOnPause, setCloseOnPause] = useState(false);
  const [publishCandidate, setPublishCandidate] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [entryScope, setEntryScope] = useState<JourneyEntryScope>("new_only");
  const estimateFn = useServerFn(getJourneyActivationEstimate);
  const estimate = useQuery({
    queryKey: ["journey-activation-estimate", publishCandidate?.id],
    queryFn: () => estimateFn({ data: { id: publishCandidate!.id } }),
    enabled: Boolean(publishCandidate),
    staleTime: 60_000,
  });
  const status = useMutation({
    mutationFn: (input: {
      id: string;
      status: Journey["status"];
      entryScope?: JourneyEntryScope;
      closeEnrollments?: boolean;
    }) => changeStatus({ data: input }),
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      setPauseCandidate(null);
      setPublishCandidate(null);
      toast.success(
        variables.status === "active"
          ? "Jornada publicada"
          : result.closed
            ? `Jornada desligada · ${result.closed} jogador(es) saíram da jornada`
            : "Jornada desligada",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const requestPublish = (journey: { id: string; name: string; trigger_type: string }) => {
    if (!activationAsksEntryScope(journey.trigger_type)) {
      status.mutate({ id: journey.id, status: "active" });
      return;
    }
    setEntryScope(defaultEntryScope(journey.trigger_type));
    setPublishCandidate({ id: journey.id, name: journey.name });
  };
  const express = useMutation({
    mutationFn: (input: { id: string; express: boolean }) => changeExpress({ data: input }),
    onSuccess: async (result) => {
      setExpressCandidate(null);
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      toast.success(
        result.express
          ? result.requeued > 0
            ? `Envio imediato ligado. ${result.requeued} lead(s) adiado(s) voltaram para a fila.`
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
  const rows = useMemo(
    () =>
      ((journeys.data?.journeys ?? []) as Journey[]).filter(
        (journey) =>
          (filter === "all" || journey.status === filter) &&
          `${journey.name} ${journey.trigger_type}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [journeys.data?.journeys, filter, search],
  );
  const overview = useMemo(() => {
    const all = (journeys.data?.journeys ?? []) as Journey[];
    return all.reduce(
      (total, journey) => {
        const metrics = journey.metrics ?? {};
        total.recovered += Number(metrics.recovered ?? 0);
        total.sent += Object.values(metrics.sentByChannel ?? {}).reduce(
          (sum, value) => sum + Number(value),
          0,
        );
        total.queued +=
          Number(metrics.byStatus?.active ?? 0) +
          Number(metrics.byStatus?.waiting ?? 0) +
          Number(metrics.byStatus?.paused_by_priority ?? 0);
        return total;
      },
      { recovered: 0, sent: 0, queued: 0 },
    );
  }, [journeys.data?.journeys]);
  return (
    <Page>
      <PageHeader
        subtitle="Sequências individuais que combinam SMS, e-mail e voz com esperas e regras de saída."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => toast.message("Importacao de modelo em breve.")}
            >
              Importar modelo
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Nova jornada
            </Button>
          </>
        }
      />
      {/* Period selector (Hoje/7/30 dias) hidden: list_journey_metrics has no
          date filter, so totals below are all-time. Restore with REP-02. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewCard
          icon={CircleDollarSign}
          label="Recuperado pelo CRM"
          value={overview.recovered.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL",
            maximumFractionDigits: 0,
          })}
          detail={ATTRIBUTED_RECOVERY_HINT}
          color="emerald"
        />
        <OverviewCard
          icon={Send}
          label="Mensagens enviadas"
          value={overview.sent.toLocaleString("pt-BR")}
          detail="Desde o início, todos os canais"
          color="blue"
        />
        <OverviewCard
          icon={UsersRound}
          label="Em andamento"
          value={overview.queued.toLocaleString("pt-BR")}
          detail="Ativos, aguardando ou pausados por prioridade"
          color="cyan"
        />
        <OverviewCard
          icon={Route}
          label="Jornadas ativas"
          value={((journeys.data?.journeys ?? []) as Journey[])
            .filter((journey) => journey.status === "active")
            .length.toLocaleString("pt-BR")}
          detail="Em execução neste momento"
          color="slate"
        />
      </div>
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground">
          <Route className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <span>
            Campanhas são disparos pontuais. Jornadas entram por gatilho e avançam pessoa a pessoa.
            Etapas de voz usam um áudio ativo da biblioteca da tenant.
          </span>
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        {(["all", "draft", "active", "paused"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={filter === item ? "default" : "outline"}
            onClick={() => setFilter(item)}
          >
            {item === "all" ? "Todas" : labels[item]}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg bg-muted p-1 text-sm">
          <button
            className={
              view === "journeys"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("journeys")}
          >
            Jornadas
          </button>
          <button
            className={
              view === "map"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("map")}
          >
            Mapa
          </button>
          <button
            className={
              view === "queue"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("queue")}
          >
            Fila de envio
          </button>
          <button
            className={
              view === "failures"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("failures")}
          >
            Falhas
          </button>
          <button
            className={
              view === "conflicts"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("conflicts")}
          >
            Conflitos
            {Number(operations.data?.summary?.pausedByPriority ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
                {operations.data?.summary?.pausedByPriority}
              </span>
            )}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void openContactSettings()}>
            Configuracoes
          </Button>
          <Button variant="outline" size="sm" onClick={() => setInfoOpen(true)}>
            Informacoes
          </Button>
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <input
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm sm:w-72"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar jornada..."
            />
          </label>
        </div>
      </div>
      {view !== "journeys" && view !== "map" && (
        <Card>
          <CardHeader>
            <CardTitle>
              {view === "queue"
                ? "Fila de envio"
                : view === "conflicts"
                  ? "Conflitos e pausas"
                  : "Falhas"}
            </CardTitle>
            <CardDescription>
              {
                (operations.data?.items ?? []).filter((item: { status: string }) =>
                  view === "failures"
                    ? item.status === "failed"
                    : view === "conflicts"
                      ? item.status === "paused_by_priority"
                      : item.status !== "failed" && item.status !== "paused_by_priority",
                ).length
              }{" "}
              registro(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(operations.data?.items ?? [])
              .filter((item: { status: string }) =>
                view === "failures"
                  ? item.status === "failed"
                  : view === "conflicts"
                    ? item.status === "paused_by_priority"
                    : item.status !== "failed" && item.status !== "paused_by_priority",
              )
              .map(
                (item: {
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
                }) => (
                  <div key={item.id} className="rounded-lg border p-3 text-sm">
                    <b>
                      {item.players?.nome ?? "Jogador"} · {item.journeys?.name ?? "Jornada"}
                    </b>
                    <p className="mt-1 text-muted-foreground">
                      Etapa {item.current_position + 1}
                      {item.next_run_at
                        ? ` · ${new Date(item.next_run_at).toLocaleString("pt-BR")}`
                        : ""}
                      {item.exit_reason ? ` · ${item.exit_reason}` : ""}
                    </p>
                    {item.status === "paused_by_priority" && (
                      <p className="mt-1 text-warning">
                        Pausada por prioridade
                        {item.priority_paused_by_journey_name
                          ? `: ${item.priority_paused_by_journey_name} venceu a disputa.`
                          : ". Aguardando o fim da jornada vencedora."}
                        {item.priority_paused_at
                          ? ` ${new Date(item.priority_paused_at).toLocaleString("pt-BR")}`
                          : ""}
                      </p>
                    )}
                  </div>
                ),
              )}
          </CardContent>
        </Card>
      )}
      {view === "map" && (
        <JourneyMapCard
          journeys={((journeys.data?.journeys ?? []) as Journey[]).map((journey) => ({
            ...journey,
            inProgress:
              Number(journey.metrics?.byStatus?.active ?? 0) +
              Number(journey.metrics?.byStatus?.waiting ?? 0) +
              Number(journey.metrics?.byStatus?.paused_by_priority ?? 0),
          }))}
        />
      )}
      {view === "journeys" && (
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle>Jornadas</CardTitle>
            <CardDescription>{rows.length} encontrada(s)</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {journeys.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Carregando jornadas…</p>
            ) : rows.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                Nenhuma jornada nesta visão.
              </div>
            ) : (
              rows.map((journey) => {
                const steps = journey.journey_steps
                  .filter((step) => step.is_enabled && step.step_type !== "end")
                  .sort((a, b) => a.position - b.position);
                const metrics = journey.metrics ?? {};
                // Leads enter the moment they qualify (ENV-09), so there is no
                // "eligible but waiting" pool: everyone inside is in progress.
                const inProgress =
                  Number(metrics.byStatus?.active ?? 0) +
                  Number(metrics.byStatus?.waiting ?? 0) +
                  Number(metrics.byStatus?.paused_by_priority ?? 0);
                const finished =
                  Number(metrics.byStatus?.completed ?? 0) + Number(metrics.byStatus?.exited ?? 0);
                const sent = Object.values(metrics.sentByChannel ?? {}).reduce(
                  (total, value) => total + Number(value),
                  0,
                );
                return (
                  <div
                    key={journey.id}
                    className="grid gap-4 border-b p-5 last:border-b-0 xl:grid-cols-[minmax(16rem,1fr)_auto_auto] xl:items-center xl:gap-6"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-semibold">{journey.name}</p>
                        <Badge
                          variant="outline"
                          className={
                            journey.status === "active"
                              ? "border-success/20 bg-success/15 text-success"
                              : "bg-muted text-muted-foreground"
                          }
                        >
                          {labels[journey.status].toLowerCase()}
                        </Badge>
                        {journey.ends_at && (
                          <Badge variant="outline" className="bg-muted text-muted-foreground">
                            {Date.parse(journey.ends_at) <= Date.now()
                              ? "encerrada em "
                              : "encerra em "}
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
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {journeyTriggerLabel(journey.trigger_type, journey.trigger_config)}
                      </p>
                      <JourneyStepSummary steps={steps} />
                    </div>
                    <div className="grid grid-cols-2 gap-x-7 gap-y-3 sm:grid-cols-4">
                      <JourneyMetric
                        label="Em andamento"
                        hint="Leads dentro da jornada agora: aguardando a próxima etapa, a janela de envio ou pausados por prioridade."
                        value={inProgress.toLocaleString("pt-BR")}
                      />
                      <JourneyMetric
                        label="Concluíram"
                        hint="Leads que terminaram a jornada ou saíram dela (por exemplo, ao depositar)."
                        value={finished.toLocaleString("pt-BR")}
                      />
                      <JourneyMetric label="Enviados" value={sent.toLocaleString("pt-BR")} />
                      <JourneyMetric
                        label="Recuperado pelo CRM"
                        hint={ATTRIBUTED_RECOVERY_HINT}
                        value={Number(metrics.recovered ?? 0).toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                          maximumFractionDigits: 0,
                        })}
                        accent
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium">
                              <Zap
                                className={
                                  journey.express
                                    ? "h-3.5 w-3.5 text-warning"
                                    : "h-3.5 w-3.5 text-muted-foreground"
                                }
                                aria-hidden="true"
                              />
                              Envio imediato
                              <Switch
                                checked={Boolean(journey.express)}
                                disabled={express.isPending}
                                aria-label={`Envio imediato (fura fila) na jornada ${journey.name}`}
                                onCheckedChange={(checked) => {
                                  if (checked) setExpressCandidate(journey);
                                  else express.mutate({ id: journey.id, express: false });
                                }}
                              />
                            </label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs whitespace-normal text-left">
                            {EXPRESS_JOURNEY_HINT}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Button asChild variant="outline" size="sm">
                        <Link to="/jornadas/$journeyId" params={{ journeyId: journey.id }}>
                          Editar
                        </Link>
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <Link
                          to="/jornadas/$journeyId/relatorio"
                          params={{ journeyId: journey.id }}
                        >
                          Ver relatório
                        </Link>
                      </Button>
                      {journey.status === "active" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={status.isPending}
                          onClick={() => {
                            setCloseOnPause(false);
                            setPauseCandidate({ id: journey.id, name: journey.name, inProgress });
                          }}
                        >
                          <Pause className="mr-1 h-4 w-4" /> Desligar
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={status.isPending || journey.status === "archived"}
                          onClick={() => requestPublish(journey)}
                        >
                          <Play className="mr-1 h-4 w-4" /> Publicar
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Excluir a jornada ${journey.name}`}
                        title="Excluir"
                        disabled={remove.isPending}
                        onClick={async () => {
                          const confirmed = await requestConfirmation({
                            title: "Excluir jornada?",
                            description: `A jornada “${journey.name}” será excluída. Esta ação não pode ser desfeita.`,
                            confirmLabel: "Excluir jornada",
                            destructive: true,
                          });
                          if (confirmed) remove.mutate(journey.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}
      {view === "journeys" && ((legacy.data?.items ?? []).length > 0 || legacy.isLoading) && (
        <Card id="legado" className="border-dashed">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Automações legadas</CardTitle>
              <Badge variant="outline">compatibilidade temporária</Badge>
            </div>
            <CardDescription>
              Plano de desativação: converter, revisar o rascunho, publicar a jornada e só então
              desligar a origem. Novas criações acontecem exclusivamente como jornadas.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {legacy.isLoading ? (
              <p className="text-sm text-muted-foreground">Carregando itens legados…</p>
            ) : (
              (legacy.data?.items ?? []).map((item: LegacyJourney) => (
                <div
                  key={`${item.sourceType}:${item.sourceId}`}
                  className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.channel === "sms" ? (
                        <MessageSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Mail className="h-4 w-4 text-primary" />
                      )}
                      <p className="font-medium">{item.name}</p>
                      <Badge variant="outline">Legado</Badge>
                      <Badge variant={item.active ? "default" : "secondary"}>
                        {item.active ? "Em execução" : "Desligada"}
                      </Badge>
                      {item.journeyId && <Badge variant="secondary">Convertida</Badge>}
                      {!item.active && item.journeyId && (
                        <Badge variant="secondary">Migração concluída</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.channel === "sms" ? "SMS" : "E-mail"} · entrada {item.trigger}
                    </p>
                  </div>
                  {item.journeyId ? (
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link to="/jornadas/$journeyId" params={{ journeyId: item.journeyId }}>
                          Abrir jornada
                        </Link>
                      </Button>
                      {item.active && item.journeyStatus === "active" && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={retire.isPending}
                          onClick={() =>
                            retire.mutate({ sourceType: item.sourceType, sourceId: item.sourceId })
                          }
                        >
                          Desativar legado
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={convert.isPending}
                      onClick={() =>
                        convert.mutate({ sourceType: item.sourceType, sourceId: item.sourceId })
                      }
                    >
                      Converter em jornada
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
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
                Leads desta jornada que foram adiados pelo intervalo entre jornadas ou por limite
                global voltam para a fila agora.
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
      <Dialog
        open={pauseCandidate !== null}
        onOpenChange={(open) => !open && setPauseCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Desligar “{pauseCandidate?.name}”</DialogTitle>
            <DialogDescription>
              {pauseCandidate?.inProgress
                ? `${pauseCandidate.inProgress.toLocaleString("pt-BR")} jogador(es) estão nesta jornada agora. Nenhuma mensagem sai enquanto ela estiver desligada.`
                : "Ninguém está nesta jornada agora."}
            </DialogDescription>
          </DialogHeader>
          {Boolean(pauseCandidate?.inProgress) && (
            <fieldset className="space-y-3 text-sm">
              <legend className="sr-only">O que fazer com quem está na jornada</legend>
              <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
                <input
                  type="radio"
                  name="pause-mode"
                  checked={!closeOnPause}
                  onChange={() => setCloseOnPause(false)}
                />
                <span>
                  <span className="font-medium">Manter os jogadores</span>
                  <span className="block text-muted-foreground">
                    Ao republicar, cada um continua de onde parou. Etapas atrasadas respeitam o
                    limite de mensagens por pessoa.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
                <input
                  type="radio"
                  name="pause-mode"
                  checked={closeOnPause}
                  onChange={() => setCloseOnPause(true)}
                />
                <span>
                  <span className="font-medium">Encerrar a participação de todos</span>
                  <span className="block text-muted-foreground">
                    Todos saem da jornada agora. Ao republicar, só entra quem cumprir o gatilho de
                    novo.
                  </span>
                </span>
              </label>
            </fieldset>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={status.isPending}
              onClick={() => setPauseCandidate(null)}
            >
              Cancelar
            </Button>
            <Button
              variant={closeOnPause ? "destructive" : "default"}
              disabled={status.isPending || !pauseCandidate}
              onClick={() =>
                pauseCandidate &&
                status.mutate({
                  id: pauseCandidate.id,
                  status: "paused",
                  closeEnrollments: closeOnPause,
                })
              }
            >
              <Pause className="mr-1 h-4 w-4" aria-hidden="true" />
              {closeOnPause ? "Desligar e encerrar" : "Desligar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={publishCandidate !== null}
        onOpenChange={(open) => !open && setPublishCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publicar “{publishCandidate?.name}”</DialogTitle>
            <DialogDescription>Quem pode entrar nesta jornada?</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-3 text-sm">
            <legend className="sr-only">Quem pode entrar</legend>
            <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
              <input
                type="radio"
                name="entry-scope"
                checked={entryScope === "new_only"}
                onChange={() => setEntryScope("new_only")}
              />
              <span>
                <span className="font-medium">Só casos novos, a partir de agora</span>
                <span className="block text-muted-foreground">
                  Ninguém da base atual entra. Quem já estava na jornada sai na próxima verificação.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
              <input
                type="radio"
                name="entry-scope"
                checked={entryScope === "include_base"}
                onChange={() => setEntryScope("include_base")}
              />
              <span>
                <span className="font-medium">Incluir a base atual</span>
                <span className="block text-muted-foreground">
                  Jogadores que já cumprem o gatilho entram nos próximos minutos e recebem o
                  primeiro passo, dentro do limite de mensagens por pessoa.
                </span>
                {estimate.isLoading ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Calculando o impacto…
                  </span>
                ) : estimate.data?.supported && estimate.data.eligible != null ? (
                  <span className="mt-1 block text-xs font-medium">
                    ≈ {estimate.data.eligible.toLocaleString("pt-BR")} jogador(es) entram agora · 1º
                    envio ≈{" "}
                    {(estimate.data.firstSendCost ?? 0).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}
                    {estimate.data.eligible > 0 &&
                      " · enquanto ficarem na régua diária, o custo se repete por dia"}
                  </span>
                ) : null}
              </span>
            </label>
          </fieldset>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={status.isPending}
              onClick={() => setPublishCandidate(null)}
            >
              Cancelar
            </Button>
            <Button
              disabled={status.isPending || !publishCandidate}
              onClick={() =>
                publishCandidate &&
                status.mutate({ id: publishCandidate.id, status: "active", entryScope })
              }
            >
              <Play className="mr-1 h-4 w-4" aria-hidden="true" /> Publicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Configuracoes</DialogTitle>
            <DialogDescription>Vale para todas as jornadas, em todos os canais.</DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border p-5">
            <h3 className="font-semibold">Limite de mensagens por pessoa</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Os limites das jornadas incluem os envios de SMS e e-mail já registrados no tenant. Em
              branco, não há limite.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">
                Maximo em 24 h
                <Input
                  className="mt-1"
                  inputMode="numeric"
                  placeholder="Sem limite"
                  value={dailyMessageLimit}
                  onChange={(event) => setDailyMessageLimit(event.target.value)}
                />
              </label>
              <label className="text-sm font-medium">
                Maximo em 7 dias
                <Input
                  className="mt-1"
                  inputMode="numeric"
                  placeholder="Sem limite"
                  value={weeklyMessageLimit}
                  onChange={(event) => setWeeklyMessageLimit(event.target.value)}
                />
              </label>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              A contagem considera mensagens ja enviadas em cada canal. Mensagens ainda agendadas
              nao entram no limite.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={saveContactLimits.isPending}
              onClick={() => saveContactLimits.mutate()}
            >
              {saveContactLimits.isPending ? "Salvando..." : "Salvar limite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Como a conta e feita</DialogTitle>
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
              sair nao voltam a receber comunicacoes.
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova jornada</DialogTitle>
            <DialogDescription>
              Escolha o gatilho. Os degraus são montados na tela seguinte.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block text-sm font-medium">
              Nome da jornada
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ex.: Sumiu depois do primeiro depósito"
              />
            </label>
            <div className="grid gap-2">
              <Button
                type="button"
                variant={entryMode === "event" ? "default" : "outline"}
                className="justify-start"
                onClick={() => setEntryMode("event")}
              >
                Quando algo acontece
              </Button>
              <Button
                type="button"
                variant={entryMode === "inactivity" ? "default" : "outline"}
                className="justify-start"
                onClick={() => setEntryMode("inactivity")}
              >
                Quando nada acontece
              </Button>
              <Button
                type="button"
                variant={entryMode === "manual" ? "default" : "outline"}
                className="justify-start"
                onClick={() => setEntryMode("manual")}
              >
                Entrada manual ou API
              </Button>
            </div>
            {entryMode === "event" && (
              <label className="block text-sm font-medium">
                Qual evento
                <select
                  className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={newTrigger}
                  onChange={(e) => setNewTrigger(e.target.value)}
                >
                  {Object.entries(TRIGGER_NAMES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {entryMode === "inactivity" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm font-medium">
                  Sem atividade em
                  <select
                    className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={inactivityField}
                    onChange={(e) => setInactivityField(e.target.value)}
                  >
                    <option value="ultimo_login">Login</option>
                    <option value="ultimo_jogo">Jogo</option>
                    <option value="ultimo_deposito">Depósito</option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Horas
                  <Input
                    type="number"
                    min={1}
                    max={8760}
                    value={inactivityHours}
                    onChange={(e) => setInactivityHours(Number(e.target.value))}
                  />
                </label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={!newName.trim()} onClick={create}>
              Criar e abrir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
const labels = { draft: "Rascunho", active: "Ativa", paused: "Pausada", archived: "Arquivada" };

const channelNames = { wait: "espera", sms: "sms", email: "e-mail", voice: "voz", end: "fim" };
const channelStyles = {
  wait: "",
  sms: "border-blue-500/30 text-blue-500",
  email: "border-violet-500/30 text-violet-500",
  voice: "border-emerald-500/30 text-emerald-500",
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
    return <p className="mt-2 text-sm text-muted-foreground">Sem etapas configuradas</p>;
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
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${channelStyles[channel as keyof typeof channelStyles]}`}
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
              className={`h-2 w-2 rounded-full border ${channelStyles[step.step_type]}`}
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
    <div className="text-right">
      <p className="flex items-center justify-end gap-1 text-meta text-muted-foreground">
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

function OverviewCard({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: typeof CircleDollarSign;
  label: string;
  value: string;
  detail: string;
  color: "emerald" | "blue" | "cyan" | "slate";
}) {
  const tones = {
    emerald: "border-l-emerald-500 bg-emerald-500/[0.06] text-emerald-400",
    blue: "border-l-blue-500 bg-blue-500/[0.06] text-blue-400",
    cyan: "border-l-cyan-400 bg-cyan-400/[0.06] text-cyan-300",
    slate: "border-l-slate-500 bg-muted/50 text-muted-foreground",
  };
  return (
    <Card className={`border-l-4 ${tones[color]}`}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="h-5 w-5" />
          {label}
        </div>
        <p className="mt-5 text-kpi text-foreground">{value}</p>
        <p className="mt-3 text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
