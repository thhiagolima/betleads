import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  simulateActivation,
  executeActivation,
  getAutomationSettings,
  getActivationStatus,
  listRecentRuns,
  setPaused,
  setChannelPaused,
  getQueueReadiness,
} from "@/lib/activation.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Loader2, Pause, Play, Rocket, FlaskConical, RefreshCw, Clock,
  AlertTriangle, CheckCircle2, Sunrise, Info, RotateCw,
} from "lucide-react";
import {
  modeLabel, statusLabel, classifyError, friendlyError,
  formatDateShort, formatDuration,
} from "@/lib/activation-labels";

export const Route = createFileRoute("/automacoes")({ component: AutomacoesPage });

type Totals = {
  analyzed?: number;
  eligible?: number;
  enqueued?: number;
  skipped?: number;
  by_trigger?: Record<string, number>;
  by_channel?: Record<string, number>;
  blocked_reasons?: Record<string, number>;
};

function AutomacoesPage() {
  const qc = useQueryClient();
  const fnSettings = useServerFn(getAutomationSettings);
  const fnStatus = useServerFn(getActivationStatus);
  const fnRuns = useServerFn(listRecentRuns);
  const fnSimulate = useServerFn(simulateActivation);
  const fnExecute = useServerFn(executeActivation);
  const fnPause = useServerFn(setPaused);
  const fnChannelPause = useServerFn(setChannelPaused);
  const fnReadiness = useServerFn(getQueueReadiness);

  const settings = useQuery({ queryKey: ["automation-settings"], queryFn: () => fnSettings() });
  const status = useQuery({ queryKey: ["activation-status"], queryFn: () => fnStatus(), refetchInterval: 10000 });
  const runs = useQuery({ queryKey: ["activation-runs"], queryFn: () => fnRuns(), refetchInterval: 10000 });
  const readiness = useQuery({ queryKey: ["queue-readiness"], queryFn: () => fnReadiness(), refetchInterval: 15000 });

  const [simResult, setSimResult] = useState<Totals | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const simulate = useMutation({
    mutationFn: async () => (await fnSimulate()) as { totals: Totals },
    onSuccess: (data) => {
      setSimResult(data.totals ?? null);
      toast.success("Simulação concluída");
      qc.invalidateQueries({ queryKey: ["activation-runs"] });
      qc.invalidateQueries({ queryKey: ["queue-readiness"] });
    },
    onError: (e: Error) => toast.error("Erro: " + e.message),
  });

  // Fire-and-forget: o reprocessamento pode levar minutos. Disparamos a chamada
  // e fechamos o modal imediatamente — o progresso aparece em "Execuções recentes".
  const [executeStarting, setExecuteStarting] = useState(false);
  function startExecute() {
    setExecuteStarting(true);
    // Não aguardamos a promise. O navegador mantém a request aberta mesmo sem await.
    fnExecute()
      .then(() => {
        qc.invalidateQueries({ queryKey: ["activation-runs"] });
        qc.invalidateQueries({ queryKey: ["activation-status"] });
        qc.invalidateQueries({ queryKey: ["queue-readiness"] });
      })
      .catch((e: Error) => toast.error("Erro ao reprocessar: " + e.message));
    setTimeout(() => {
      toast.success("Reprocessamento iniciado", {
        description: "Acompanhe o progresso em Execuções recentes logo abaixo.",
      });
      setConfirmOpen(false);
      setConfirmText("");
      setExecuteStarting(false);
      qc.invalidateQueries({ queryKey: ["activation-runs"] });
    }, 600);
  }

  const togglePause = useMutation({
    mutationFn: async (paused: boolean) => fnPause({ data: { paused } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-settings"] });
      toast.success("Atualizado");
    },
  });

  const toggleChannel = useMutation({
    mutationFn: async (v: { channel: "sms" | "email" | "call" | "whatsapp"; paused: boolean }) =>
      fnChannelPause({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-settings"] });
      toast.success("Canal atualizado");
    },
  });

  const s = settings.data?.settings;
  const paused = !!s?.paused;
  const channelPaused = {
    sms: !!(s as { sms_paused?: boolean } | null)?.sms_paused,
    email: !!(s as { email_paused?: boolean } | null)?.email_paused,
    call: !!(s as { call_paused?: boolean } | null)?.call_paused,
    whatsapp: !!(s as { whatsapp_paused?: boolean } | null)?.whatsapp_paused,
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" /> Automações — Ativação de fluxos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Identifica o estado de cada lead e enfileira nos fluxos corretos de SMS, Email, Ligação e WhatsApp,
            respeitando prioridade, cooldown e limite diário.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={paused ? "destructive" : "default"}>
            {paused ? "Pausado" : "Ativo"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => togglePause.mutate(!paused)}>
            {paused ? <><Play className="h-4 w-4 mr-1" /> Retomar</> : <><Pause className="h-4 w-4 mr-1" /> Pausar tudo</>}
          </Button>
        </div>
      </div>

      {/* Pause por canal */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Disparos por canal</CardTitle>
          <CardDescription className="text-xs">
            Liga/desliga cada canal individualmente. O botão "Pausar tudo" acima sobrepõe estes ajustes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(["sms", "email", "call", "whatsapp"] as const).map((ch) => {
              const isPaused = channelPaused[ch];
              const label = ch === "sms" ? "SMS" : ch === "email" ? "E-mail" : ch === "call" ? "Ligação" : "WhatsApp";
              const disabled = paused || toggleChannel.isPending;
              return (
                <div
                  key={ch}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div>
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-muted-foreground">
                      {paused ? "Pausa global ativa" : isPaused ? "Pausado" : "Ativo"}
                    </div>
                  </div>
                  <Switch
                    checked={!isPaused && !paused}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      toggleChannel.mutate({ channel: ch, paused: !checked })
                    }
                  />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["sms", "email", "call", "whatsapp"] as const).map((ch) => (
          <Card key={ch}>
            <CardHeader className="pb-2">
              <CardDescription className="uppercase text-xs">{ch}</CardDescription>
              <CardTitle className="text-2xl">
                {status.data?.sentToday?.[ch] ?? 0}
                <span className="text-xs text-muted-foreground font-normal ml-1">
                  enviados hoje{ch === "email" ? " (sem limite)" : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {status.data?.pending?.[ch] ?? 0} pendentes na fila
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Prontidão para a janela 06:00 BRT */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sunrise className="h-5 w-5 text-primary" /> Prontidão da fila — janela 06:00–22:00 (America/Sao_Paulo)
          </CardTitle>
          <CardDescription>
            Rotinas automáticas rodam no backend (cron) sem depender desta tela. Os dispatchers respeitam prioridade,
            limite diário, cooldown, opt-out, condições de saída, canal disponível e intervalos anti-ban.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" /> Próxima execução
              </div>
              <div className="font-semibold mt-1">
                {readiness.data?.nextRunAt
                  ? new Date(readiness.data.nextRunAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
                  : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {readiness.data?.insideWindow ? "Dentro da janela" : "Fora da janela — aguardando 06:00 BRT"}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Status da rotina</div>
              <div className="font-semibold mt-1 flex items-center gap-1">
                {readiness.data?.paused ? (
                  <><Pause className="h-4 w-4 text-destructive" /> Pausada</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4 text-green-600" /> Ativa</>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Cron a cada 1 min</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Pendentes p/ 06:00</div>
              <div className="font-semibold text-lg mt-1">{readiness.data?.totalPending ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">
                SMS {readiness.data?.pending.sms ?? 0} · Email {readiness.data?.pending.email ?? 0} · Lig {readiness.data?.pending.call ?? 0} · WA {readiness.data?.pending.whatsapp ?? 0}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Última execução</div>
              <div className="font-semibold mt-1">
                {readiness.data?.lastRun?.started_at
                  ? new Date(readiness.data.lastRun.started_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
                  : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {readiness.data?.lastRun?.mode ?? "—"} · {readiness.data?.lastRun?.status ?? "—"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={() => simulate.mutate()} disabled={simulate.isPending}>
              {simulate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sunrise className="h-4 w-4 mr-1" />}
              Testar rotina das 06:00
            </Button>
            <span className="text-xs text-muted-foreground">
              Simula a execução sem enviar nada e mostra quantos leads seriam disparados, bloqueados, por canal e por fluxo.
            </span>
          </div>

          <RecentEventsBlock errors={readiness.data?.recentErrors ?? []} />

          <div className="text-xs text-muted-foreground border-t pt-2">
            Logs de envio, bloqueio e erro ficam em <code>sms_send_logs</code>, <code>email_send_logs</code>,
            <code> call_history</code> e <code>flow_logs</code>. Anti-ban aplica intervalo entre envios
            (delay min/max) e tetos por hora/dia.
          </div>
        </CardContent>
      </Card>

      {/* Ações */}
      <Card>
        <CardHeader>
          <CardTitle>Reprocessar leads existentes agora</CardTitle>
          <CardDescription>
            A rotina automática já roda no backend a cada poucos minutos e enfileira sozinha todo lead novo
            que entra em algum estado. Use os botões abaixo apenas quando:
            <span className="block mt-1">
              • Você acabou de criar um gatilho ou fluxo novo e quer pegar leads que já estavam elegíveis.
            </span>
            <span className="block">
              • Suspeita que algo ficou de fora e quer forçar uma varredura completa agora.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => simulate.mutate()} disabled={simulate.isPending} variant="outline">
              {simulate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />}
              Simular sem enviar
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={paused}>
              <RotateCw className="h-4 w-4 mr-1" /> Reprocessar agora
            </Button>
          </div>

          {simResult && (
            <div className="rounded-md border bg-muted/30 p-4 space-y-3 text-sm">
              <div className="flex flex-wrap gap-4">
                <span><strong>Analisados:</strong> {simResult.analyzed ?? 0}</span>
                <span><strong>Elegíveis:</strong> {simResult.eligible ?? 0}</span>
                <span><strong>Enfileiráveis:</strong> {simResult.enqueued ?? 0}</span>
                <span><strong>Ignorados:</strong> {simResult.skipped ?? 0}</span>
              </div>
              <BreakdownBlock title="Por canal" map={simResult.by_channel} />
              <BreakdownBlock title="Por gatilho" map={simResult.by_trigger} />
              <BreakdownBlock title="Motivos de bloqueio" map={simResult.blocked_reasons} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Execuções recentes</CardTitle>
            <CardDescription>
              Cada linha é um ciclo da rotina automática (cron) ou um reprocessamento que você disparou aqui.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => runs.refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {runs.data?.runs?.length ? (
            runs.data.runs.map((r) => <RunRow key={r.id} run={r} />)
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma execução ainda.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reprocessar leads agora?</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                Vou varrer toda a base de players, identificar quem se encaixa em algum gatilho ativo
                e enfileirar nos fluxos de SMS, e-mail, ligação e WhatsApp — respeitando prioridade,
                cooldown, limite diário e a janela de envio.
              </span>
              <span className="block">
                <strong>Você não precisa esperar nesta tela.</strong> O trabalho roda em segundo plano
                e o resultado aparece em "Execuções recentes" logo abaixo. Para confirmar, digite{" "}
                <strong>REPROCESSAR</strong>.
              </span>
            </DialogDescription>
          </DialogHeader>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="REPROCESSAR" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button
              disabled={confirmText !== "REPROCESSAR" || executeStarting}
              onClick={startExecute}
            >
              {executeStarting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Iniciar reprocessamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunRow({ run: r }: { run: any }) {
  const t = (r.totals ?? {}) as Totals;
  const isExec = r.mode === "execute";
  const errKind = classifyError(r.error);
  const status = r.status as string;
  const statusClass =
    status === "running"
      ? "bg-blue-500/15 text-blue-600 border-blue-500/30"
      : status === "done" || status === "ok"
        ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
        : errKind === "operational"
          ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
          : "bg-destructive/15 text-destructive border-destructive/30";
  const duration = formatDuration(r.started_at, r.finished_at);
  const analyzed = t.analyzed ?? 0;
  const enqueued = t.enqueued ?? 0;
  return (
    <div className="flex items-center justify-between gap-3 text-sm border-b py-2 last:border-0">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <Badge variant="outline" className="font-normal">
          {isExec ? <RotateCw className="h-3 w-3 mr-1" /> : <FlaskConical className="h-3 w-3 mr-1" />}
          {modeLabel(r.mode)}
        </Badge>
        <Badge variant="outline" className={`font-normal ${statusClass}`}>
          {status === "error" && errKind === "operational" ? "Reiniciado" : statusLabel(status)}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {formatDateShort(r.started_at)}
          {duration ? ` · ${duration}` : ""}
        </span>
        {r.error && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                <Info className="h-3 w-3 mr-1" /> Ver detalhes
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-xs">
              <div className="font-semibold mb-1">
                {errKind === "operational" ? "Aviso de operação" : "Falha"}
              </div>
              <p className="text-muted-foreground mb-2">{friendlyError(r.error)}</p>
              <div className="border-t pt-2 font-mono text-[10px] text-muted-foreground break-all">
                {r.error}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="text-xs text-muted-foreground text-right shrink-0">
        {enqueued > 0
          ? <>{analyzed.toLocaleString("pt-BR")} analisados · <strong className="text-foreground">{enqueued.toLocaleString("pt-BR")} enfileirados</strong></>
          : status === "running"
            ? "Em execução…"
            : "Nenhum lead novo no ciclo"}
      </div>
    </div>
  );
}

function RecentEventsBlock({ errors }: { errors: Array<{ id: string; started_at: string; error: string | null; mode?: string }> }) {
  if (!errors.length) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <span className="text-foreground">
          Sistema operando normalmente — nenhum aviso ou falha nas últimas execuções.
        </span>
      </div>
    );
  }
  const operational = errors.filter((e) => classifyError(e.error) === "operational");
  const failures = errors.filter((e) => classifyError(e.error) === "failure");

  return (
    <div className="space-y-3">
      {failures.length === 0 && operational.length > 0 && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
          <span>
            <strong>Envios em dia.</strong> No período só há avisos de operação do varredor de leads — isso
            não afeta SMS, e-mail nem ligações.
          </span>
        </div>
      )}

      {failures.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="text-xs font-semibold text-destructive flex items-center gap-1 mb-2">
            <AlertTriangle className="h-3 w-3" /> Falhas reais ({failures.length})
          </div>
          <ul className="text-xs space-y-1">
            {failures.map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0">{formatDateShort(e.started_at)}</span>
                <span className="text-foreground">{e.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {operational.length > 0 && (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs font-semibold flex items-center gap-1 mb-2 text-muted-foreground">
            <Clock className="h-3 w-3" /> Avisos de operação ({operational.length})
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            O varredor de leads excedeu o tempo limite e foi reiniciado automaticamente. Isso é esperado
            enquanto a base cresce — <strong>os envios de SMS, e-mail e ligações continuam normalmente</strong>.
          </p>
          <ul className="text-xs space-y-1">
            {operational.map((e) => (
              <li key={e.id} className="text-muted-foreground">
                {formatDateShort(e.started_at)} — ciclo reiniciado
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BreakdownBlock({ title, map }: { title: string; map?: Record<string, number> }) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return null;
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{title}</div>
      <div className="flex flex-wrap gap-2">
        {entries.map(([k, v]) => (
          <Badge key={k} variant="outline" className="font-normal">
            {k}: <strong className="ml-1">{v}</strong>
          </Badge>
        ))}
      </div>
    </div>
  );
}
