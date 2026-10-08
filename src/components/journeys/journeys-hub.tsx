import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Route,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  convertLegacyJourney,
  deleteJourney,
  listJourneyOperations,
  listJourneys,
  listLegacyJourneys,
  retireLegacyJourney,
  setJourneyStatus,
} from "@/lib/journeys.functions";
import { Button } from "@/components/ui/button";
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
import { TRIGGER_NAMES } from "@/lib/triggers";

type Journey = {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "archived";
  trigger_type: string;
  daily_limit: number;
  journey_steps: Array<{
    id: string;
    position: number;
    step_type: "wait" | "sms" | "email" | "voice" | "end";
    config: Record<string, unknown>;
    is_enabled: boolean;
  }>;
  metrics: {
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
  const removeJourney = useServerFn(deleteJourney);
  const operationsFn = useServerFn(listJourneyOperations);
  const legacyFn = useServerFn(listLegacyJourneys);
  const convertFn = useServerFn(convertLegacyJourney);
  const retireFn = useServerFn(retireLegacyJourney);
  const [filter, setFilter] = useState<"all" | Journey["status"]>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"journeys" | "queue" | "failures">("journeys");
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
  const operations = useQuery({ queryKey: ["journey-operations"], queryFn: () => operationsFn() });
  const legacy = useQuery({ queryKey: ["legacy-journeys"], queryFn: () => legacyFn() });
  const status = useMutation({
    mutationFn: (input: { id: string; status: Journey["status"] }) => changeStatus({ data: input }),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      toast.success(variables.status === "active" ? "Jornada publicada" : "Jornada desligada");
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
  const rows = useMemo(
    () =>
      ((journeys.data?.journeys ?? []) as Journey[]).filter(
        (journey) =>
          (filter === "all" || journey.status === filter) &&
          `${journey.name} ${journey.trigger_type}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [journeys.data?.journeys, filter, search],
  );
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">Automações</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Jornadas multicanal</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sequências individuais que combinam SMS, e-mail e voz com esperas e regras de saída.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Nova jornada
        </Button>
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
        </div>
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
      {view !== "journeys" && (
        <Card>
          <CardHeader>
            <CardTitle>{view === "queue" ? "Fila de envio" : "Falhas"}</CardTitle>
            <CardDescription>
              {
                (operations.data?.items ?? []).filter((item: { status: string }) =>
                  view === "failures" ? item.status === "failed" : item.status !== "failed",
                ).length
              }{" "}
              registro(s)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(operations.data?.items ?? [])
              .filter((item: { status: string }) =>
                view === "failures" ? item.status === "failed" : item.status !== "failed",
              )
              .map(
                (item: {
                  id: string;
                  status: string;
                  current_position: number;
                  next_run_at: string | null;
                  exit_reason: string | null;
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
                  </div>
                ),
              )}
          </CardContent>
        </Card>
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
                const queued =
                  Number(metrics.byStatus?.active ?? 0) + Number(metrics.byStatus?.waiting ?? 0);
                const sent = Object.values(metrics.sentByChannel ?? {}).reduce(
                  (total, value) => total + Number(value),
                  0,
                );
                const deposits =
                  Number(metrics.exits?.deposit ?? 0) + Number(metrics.exits?.first_deposit ?? 0);
                return (
                  <div
                    key={journey.id}
                    className="grid gap-5 border-b p-5 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{journey.name}</p>
                        <Badge
                          variant="outline"
                          className={
                            journey.status === "active"
                              ? "border-emerald-500/20 bg-emerald-500/15 text-emerald-500"
                              : "bg-muted text-muted-foreground"
                          }
                        >
                          {labels[journey.status].toLowerCase()}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {steps.length === 0 ? (
                          <span>Sem etapas configuradas</span>
                        ) : (
                          steps.map((step, index) =>
                            step.step_type === "wait" ? (
                              <span key={step.id}>
                                {formatWait(Number(step.config.delay_seconds ?? 0))}
                              </span>
                            ) : (
                              <span key={step.id} className="contents">
                                {index > 0 && steps[index - 1]?.step_type !== "wait" && (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                                <span
                                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${channelStyles[step.step_type]}`}
                                >
                                  {channelNames[step.step_type]}
                                </span>
                                {index < steps.length - 1 && <ChevronRight className="h-4 w-4" />}
                              </span>
                            ),
                          )
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-7 gap-y-3 sm:grid-cols-4">
                      <JourneyMetric label="Na fila" value={queued.toLocaleString("pt-BR")} />
                      <JourneyMetric label="Enviados" value={sent.toLocaleString("pt-BR")} />
                      <JourneyMetric label="Depósitos" value={deposits.toLocaleString("pt-BR")} />
                      <JourneyMetric
                        label="Recuperado"
                        value={Number(metrics.recovered ?? 0).toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                          maximumFractionDigits: 0,
                        })}
                        accent
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
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
                          onClick={() => status.mutate({ id: journey.id, status: "paused" })}
                        >
                          <Pause className="mr-1 h-4 w-4" /> Desligar
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={status.isPending || journey.status === "archived"}
                          onClick={() => status.mutate({ id: journey.id, status: "active" })}
                        >
                          <Play className="mr-1 h-4 w-4" /> Publicar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Excluir a jornada “${journey.name}”? Esta ação não pode ser desfeita.`,
                            )
                          )
                            remove.mutate(journey.id);
                        }}
                      >
                        <Trash2 className="mr-1 h-4 w-4" /> Excluir
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
    </div>
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
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="text-right">
      <p className="whitespace-nowrap text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 font-semibold tabular-nums ${accent ? "text-emerald-500" : ""}`}>
        {value}
      </p>
    </div>
  );
}
