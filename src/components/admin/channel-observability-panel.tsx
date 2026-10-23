import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlert, Pause, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataCard } from "@/components/ui-premium/data-card";
import { requestConfirmation } from "@/components/system-dialog-host";
import {
  getChannelObservability,
  reprocessStuckChannel,
  setChannelOperationalPause,
  type ChannelObservability,
  type ObservabilityChannel,
} from "@/lib/channel-observability.functions";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";

const labels: Record<ObservabilityChannel, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

/** Minimum reason length accepted by `setChannelOperationalPause`. */
const MIN_REASON = 3;
const RESUME_DEFAULT_REASON = "Retomada operacional manual";

function percent(value: number) {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/**
 * SMS and e-mail providers only acknowledge the send (no delivery receipt), so
 * their rate is "accepted"; only voice reports a real outcome (answered calls).
 */
function deliveryMetricLabel(data: Pick<ChannelObservability, "channel" | "deliveryMetric">) {
  const metric = data.deliveryMetric ?? (data.channel === "voice" ? "answered" : "accepted");
  return metric === "answered" ? "Atendidas 24h" : "Aceitos 24h";
}

export function ChannelObservabilityPanel() {
  const { isSuperAdmin } = useIsSuperAdmin();
  const queryClient = useQueryClient();
  const getOverview = useServerFn(getChannelObservability);
  const setPause = useServerFn(setChannelOperationalPause);
  const reprocess = useServerFn(reprocessStuckChannel);
  const [reasons, setReasons] = useState<Partial<Record<ObservabilityChannel, string>>>({});
  const overview = useQuery({
    queryKey: ["channel-observability"],
    queryFn: () => getOverview(),
    refetchInterval: 30_000,
    enabled: isSuperAdmin,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["channel-observability"] });
  const pause = useMutation({
    mutationFn: ({
      channel,
      paused,
      reason,
    }: {
      channel: ObservabilityChannel;
      paused: boolean;
      reason: string;
    }) => setPause({ data: { channel, paused, reason } }),
    onSuccess: (_result, { channel, paused }) => {
      toast.success(paused ? "Envios pausados e registrados" : "Envios retomados e registrados");
      setReasons((current) => ({ ...current, [channel]: "" }));
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const retry = useMutation({
    mutationFn: (channel: ObservabilityChannel) => reprocess({ data: { channel } }),
    onSuccess: ({ recovered }) => {
      toast.success(
        recovered === 1
          ? "1 envio travado liberado"
          : `${num(recovered)} envios travados liberados`,
      );
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function togglePause(channel: ObservabilityChannel, paused: boolean) {
    const typed = reasons[channel]?.trim() ?? "";
    const label = labels[channel];
    if (paused && typed.length < MIN_REASON) {
      toast.error("Escreva o motivo da pausa antes de pausar.");
      return;
    }
    const confirmed = await requestConfirmation(
      paused
        ? {
            title: `Pausar os envios de ${label}?`,
            description: `Nenhum envio de ${label} sai até alguém retomar. Motivo registrado: "${typed}".`,
            confirmLabel: "Pausar envios",
            destructive: true,
          }
        : {
            title: `Retomar os envios de ${label}?`,
            description: `Os envios de ${label} que estavam aguardando voltam a sair.`,
            confirmLabel: "Retomar envios",
          },
    );
    if (!confirmed) return;
    pause.mutate({
      channel,
      paused,
      reason: typed.length >= MIN_REASON ? typed : RESUME_DEFAULT_REASON,
    });
  }

  async function reprocessChannel(channel: ObservabilityChannel, stuck: number) {
    const confirmed = await requestConfirmation({
      title: `Reenviar travados de ${labels[channel]}?`,
      description:
        stuck === 1
          ? "1 envio parado há muito tempo volta para a fila."
          : `${num(stuck)} envios parados há muito tempo voltam para a fila.`,
      confirmLabel: "Reenviar travados",
    });
    if (confirmed) retry.mutate(channel);
  }

  if (!isSuperAdmin) return null;

  return (
    <DataCard
      title="Operação dos canais"
      description="Provedor, fila, envios travados, resultado das últimas 24h e atraso do processamento."
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw className={cn("mr-1 size-3.5", overview.isFetching && "animate-spin")} />
          Atualizar
        </Button>
      }
    >
      {overview.isLoading && (
        <p className="text-body text-muted-foreground">Carregando operação…</p>
      )}
      {overview.isError && (
        <div className="flex items-center gap-2 text-body text-destructive" role="alert">
          <CircleAlert className="size-4" /> Não foi possível carregar a operação dos canais.
        </div>
      )}
      <div className="grid gap-3 xl:grid-cols-3">
        {(overview.data?.channels ?? []).map((channel) => (
          <ChannelCard
            key={channel.channel}
            data={channel}
            reason={reasons[channel.channel] ?? ""}
            onReasonChange={(reason) =>
              setReasons((current) => ({ ...current, [channel.channel]: reason }))
            }
            onPause={(paused) => void togglePause(channel.channel, paused)}
            onReprocess={() => void reprocessChannel(channel.channel, channel.stuck)}
            busy={pause.isPending || retry.isPending}
          />
        ))}
      </div>
    </DataCard>
  );
}

function ChannelCard({
  data,
  reason,
  onReasonChange,
  onPause,
  onReprocess,
  busy,
}: {
  data: ChannelObservability;
  reason: string;
  onReasonChange: (value: string) => void;
  onPause: (paused: boolean) => void;
  onReprocess: () => void;
  busy: boolean;
}) {
  const healthy = data.providerAvailable && data.workerHealthy && data.stuck === 0 && !data.paused;
  const reasonMissing = !data.paused && reason.trim().length < MIN_REASON;
  const reasonId = `channel-reason-${data.channel}`;
  return (
    <section
      className="space-y-3 rounded-xl border border-border/70 p-4"
      aria-label={`Operação ${labels[data.channel]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{labels[data.channel]}</h3>
          <p className="text-meta text-muted-foreground">{data.provider}</p>
        </div>
        <Badge
          variant="outline"
          className={healthy ? "border-success/40 text-success" : "border-warning/40 text-warning"}
        >
          {data.paused ? "Pausado" : healthy ? "Saudável" : "Atenção"}
        </Badge>
      </div>
      {data.providerBreaker && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-meta text-destructive"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{data.providerBreaker.message}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 text-meta">
        <Metric label="Na fila" value={num(data.pending)} />
        <Metric label="Travados" value={num(data.stuck)} danger={data.stuck > 0} />
        <Metric label={deliveryMetricLabel(data)} value={percent(data.deliveryRate)} />
        <Metric label="Erros 24h" value={percent(data.errorRate)} danger={data.errorRate >= 5} />
        <Metric
          label="Processamento"
          value={
            data.workerDelayMinutes === null
              ? "Sem execução"
              : `há ${num(data.workerDelayMinutes)} min`
          }
          danger={!data.workerHealthy}
        />
        <Metric
          label="Provedor"
          value={
            data.providerBreaker
              ? "Suspenso"
              : data.providerAvailable
                ? "Disponível"
                : data.providerConfigured
                  ? "Aguardando nova tentativa"
                  : "Não configurado"
          }
          danger={!data.providerAvailable}
        />
      </div>
      {((!data.providerBreaker && data.providerError) || data.pauseReason) && (
        <p className="rounded-md bg-muted px-2 py-1.5 text-meta text-muted-foreground">
          {(!data.providerBreaker && data.providerError) || data.pauseReason}
        </p>
      )}
      <div className="space-y-1">
        <Input
          id={reasonId}
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder={data.paused ? "Motivo da retomada (opcional)" : "Motivo da pausa"}
          aria-label={`Motivo da ação em ${labels[data.channel]}`}
          aria-required={!data.paused || undefined}
        />
        {!data.paused && (
          <p className="text-meta text-muted-foreground">
            Obrigatório para pausar. Fica registrado no histórico.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={data.paused ? "default" : "outline"}
          disabled={busy || reasonMissing}
          onClick={() => onPause(!data.paused)}
        >
          {data.paused ? <Play className="mr-1 size-3.5" /> : <Pause className="mr-1 size-3.5" />}
          {data.paused ? "Retomar" : "Pausar"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || data.stuck === 0}
          onClick={onReprocess}
        >
          <RefreshCw className="mr-1 size-3.5" /> Reenviar travados
        </Button>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string | number;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/60 p-2">
      <span className="text-muted-foreground">{label}</span>
      <strong className={cn("block text-body text-foreground", danger && "text-destructive")}>
        {value}
      </strong>
    </div>
  );
}
