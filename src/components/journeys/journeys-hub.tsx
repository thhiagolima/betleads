import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Mail,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Route,
  Search,
  Timer,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { listJourneyOperations, listJourneys, setJourneyStatus } from "@/lib/journeys.functions";
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
  journey_steps: Array<{ id: string }>;
};

export function JourneysHub() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useServerFn(listJourneys);
  const changeStatus = useServerFn(setJourneyStatus);
  const operationsFn = useServerFn(listJourneyOperations);
  const [filter, setFilter] = useState<"all" | Journey["status"]>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"rules" | "queue" | "failures">("rules");
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [entryMode, setEntryMode] = useState<"event" | "inactivity" | "manual">("event");
  const [newTrigger, setNewTrigger] = useState("lead_cadastrado");
  const create = () => {
    window.sessionStorage.setItem(
      "journey-draft",
      JSON.stringify({
        name: newName,
        trigger: entryMode === "manual" ? "manual" : newTrigger,
        entryMode,
      }),
    );
    setNewOpen(false);
    navigate({ to: "/jornadas/nova" });
  };
  const journeys = useQuery({ queryKey: ["journeys"], queryFn: () => list() });
  const operations = useQuery({ queryKey: ["journey-operations"], queryFn: () => operationsFn() });
  const status = useMutation({
    mutationFn: (input: { id: string; status: Journey["status"] }) => changeStatus({ data: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["journeys"] }),
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
          <Plus className="mr-2 h-4 w-4" /> Nova régua
        </Button>
      </div>
      <Card className="border-primary/20 bg-primary/[0.03]">
        <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground">
          <Route className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <span>
            Campanhas são disparos pontuais. Jornadas entram por gatilho e avançam pessoa a pessoa.
            A voz será liberada após o upload do áudio estar concluído.
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
              view === "rules"
                ? "rounded-md bg-background px-3 py-2 font-medium shadow-sm"
                : "px-3 py-2 text-muted-foreground"
            }
            onClick={() => setView("rules")}
          >
            Réguas
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
            placeholder="Buscar régua..."
          />
        </label>
      </div>
      {view !== "rules" && (
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
      {view === "rules" && (
        <Card>
          <CardHeader>
            <CardTitle>Jornadas</CardTitle>
            <CardDescription>{rows.length} encontrada(s)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {journeys.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Carregando jornadas…</p>
            ) : rows.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                Nenhuma jornada nesta visão.
              </div>
            ) : (
              rows.map((journey) => (
                <div
                  key={journey.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{journey.name}</p>
                      <Badge variant={journey.status === "active" ? "default" : "outline"}>
                        {labels[journey.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {journey.description || `Gatilho: ${journey.trigger_type}`}
                    </p>
                    <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
                      <span>{journey.journey_steps.length} etapas</span>
                      <span>Limite diário: {journey.daily_limit}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link to="/jornadas/$journeyId" params={{ journeyId: journey.id }}>
                        Editar
                      </Link>
                    </Button>
                    {journey.status === "active" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={status.isPending}
                        onClick={() => status.mutate({ id: journey.id, status: "paused" })}
                      >
                        <Pause className="mr-1 h-4 w-4" /> Pausar
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
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <ChannelCard icon={<MessageSquare className="h-4 w-4" />} text="SMS" />
        <ChannelCard icon={<Mail className="h-4 w-4" />} text="E-mail" />
        <ChannelCard icon={<Volume2 className="h-4 w-4" />} text="Voz por áudio" pending />
      </div>
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova régua</DialogTitle>
            <DialogDescription>
              Escolha o gatilho. Os degraus são montados na tela seguinte.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block text-sm font-medium">
              Nome da régua
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
            {entryMode !== "manual" && (
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
function ChannelCard({
  icon,
  text,
  pending,
}: {
  icon: React.ReactNode;
  text: string;
  pending?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-2 p-4 text-sm">
        <span className="text-primary">{icon}</span>
        {text}
        {pending ? (
          <span className="ml-auto text-xs text-muted-foreground">em preparação</span>
        ) : (
          <Timer className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </CardContent>
    </Card>
  );
}
