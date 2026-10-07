import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, CircleAlert, Pause, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  getChannelObservability,
  reprocessStuckChannel,
  setChannelOperationalPause,
  type ChannelObservability,
  type ObservabilityChannel,
} from "@/lib/channel-observability.functions";
import { cn } from "@/lib/utils";

const labels: Record<ObservabilityChannel, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

export function ChannelObservabilityPanel() {
  const queryClient = useQueryClient();
  const getOverview = useServerFn(getChannelObservability);
  const setPause = useServerFn(setChannelOperationalPause);
  const reprocess = useServerFn(reprocessStuckChannel);
  const [reasons, setReasons] = useState<Partial<Record<ObservabilityChannel, string>>>({});
  const overview = useQuery({
    queryKey: ["channel-observability"],
    queryFn: () => getOverview(),
    refetchInterval: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["channel-observability"] });
  const pause = useMutation({
    mutationFn: ({ channel, paused }: { channel: ObservabilityChannel; paused: boolean }) => {
      const reason =
        reasons[channel]?.trim() ||
        (paused ? "Pausa operacional manual" : "Retomada operacional manual");
      return setPause({ data: { channel, paused, reason } });
    },
    onSuccess: () => {
      toast.success("Estado operacional atualizado e auditado");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const retry = useMutation({
    mutationFn: (channel: ObservabilityChannel) => reprocess({ data: { channel } }),
    onSuccess: ({ recovered }) => {
      toast.success(`${recovered} item(ns) preso(s) liberado(s)`);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card className="border-border/70 bg-card/70">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4 text-primary" /> Operação dos canais
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Provedor, fila, itens presos, entrega nas últimas 24h e atraso do worker.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => overview.refetch()}
          disabled={overview.isFetching}
        >
          <RefreshCw className={cn("mr-1 size-3.5", overview.isFetching && "animate-spin")} />
          Atualizar
        </Button>
      </CardHeader>
      <CardContent>
        {overview.isLoading && (
          <p className="text-sm text-muted-foreground">Carregando operação…</p>
        )}
        {overview.isError && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
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
              onPause={(paused) => pause.mutate({ channel: channel.channel, paused })}
              onReprocess={() => retry.mutate(channel.channel)}
              busy={pause.isPending || retry.isPending}
            />
          ))}
        </div>
      </CardContent>
    </Card>
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
  return (
    <section
      className="space-y-3 rounded-xl border border-border/70 p-4"
      aria-label={`Operação ${labels[data.channel]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{labels[data.channel]}</h3>
          <p className="text-xs text-muted-foreground">{data.provider}</p>
        </div>
        <Badge
          variant="outline"
          className={
            healthy
              ? "border-emerald-500/40 text-emerald-600"
              : "border-amber-500/40 text-amber-600"
          }
        >
          {data.paused ? "Pausado" : healthy ? "Saudável" : "Atenção"}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Metric label="Pendentes" value={data.pending} />
        <Metric label="Presos" value={data.stuck} danger={data.stuck > 0} />
        <Metric label="Entrega 24h" value={`${data.deliveryRate}%`} />
        <Metric label="Erros 24h" value={`${data.errorRate}%`} danger={data.errorRate >= 5} />
        <Metric
          label="Worker"
          value={
            data.workerDelayMinutes === null ? "Sem execução" : `${data.workerDelayMinutes} min`
          }
          danger={!data.workerHealthy}
        />
        <Metric
          label="Provedor"
          value={
            data.providerAvailable
              ? "Disponível"
              : data.providerConfigured
                ? "Em backoff"
                : "Não configurado"
          }
          danger={!data.providerAvailable}
        />
      </div>
      {(data.providerError || data.pauseReason) && (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {data.providerError || data.pauseReason}
        </p>
      )}
      <Input
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        placeholder="Motivo da ação (auditado)"
        aria-label={`Motivo da ação em ${labels[data.channel]}`}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={data.paused ? "default" : "outline"}
          disabled={busy}
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
          <RefreshCw className="mr-1 size-3.5" /> Reprocessar presos
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
      <strong className={cn("block text-sm text-foreground", danger && "text-destructive")}>
        {value}
      </strong>
    </div>
  );
}
