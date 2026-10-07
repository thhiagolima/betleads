import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  getDispatchPauseState,
  setDispatchPause,
  type DispatchChannel,
} from "@/lib/dispatch-pause.functions";
import { tenantSafeChannelError } from "@/lib/channel-error";

const LABEL: Record<DispatchChannel, string> = {
  sms: "SMS",
  email: "Email",
  call: "Ligações",
};

export function ProvidersPausedBanner({ channel }: { channel: DispatchChannel }) {
  const fetchState = useServerFn(getDispatchPauseState);
  const togglePause = useServerFn(setDispatchPause);
  const qc = useQueryClient();
  const [supportRequested, setSupportRequested] = useState(false);

  const { data } = useQuery({
    queryKey: ["dispatch-pause-state"],
    queryFn: () => fetchState(),
    refetchInterval: 15_000,
  });

  const mut = useMutation({
    mutationFn: (paused: boolean) =>
      togglePause({
        data: {
          channel,
          paused,
          reason: paused ? "Pausa manual" : undefined,
        },
      }),
    onSuccess: (_r, paused) => {
      toast.success(
        paused
          ? `Disparos de ${LABEL[channel]} pausados.`
          : `Disparos de ${LABEL[channel]} retomados — fila vai drenar nos próximos segundos.`,
      );
      qc.invalidateQueries({ queryKey: ["dispatch-pause-state"] });
    },
    onError: (e: unknown) => {
      toast.error(tenantSafeChannelError(e));
    },
  });

  const row = data?.[channel];
  if (!row?.paused) return null;
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200 flex items-start gap-3">
      <Pause className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium">Disparos de {LABEL[channel]} pausados</div>
        <div className="text-xs opacity-80">
          O canal está temporariamente indisponível. Nada foi perdido: campanhas e pendências
          continuam preservadas e serão processadas quando o serviço for retomado.
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSupportRequested(true);
            toast.success("Solicitação registrada. O suporte técnico foi avisado.");
          }}
          disabled={supportRequested}
          className="border-amber-500/40 text-amber-100 hover:bg-amber-500/10"
        >
          <LifeBuoy className="h-3.5 w-3.5 mr-1.5" />
          {supportRequested ? "Suporte avisado" : "Avisar suporte"}
        </Button>
        <Button
          size="sm"
          onClick={() => mut.mutate(false)}
          disabled={mut.isPending}
          className="bg-amber-500 text-amber-950 hover:bg-amber-400"
        >
          <Play className="h-3.5 w-3.5 mr-1.5" /> Iniciar disparos
        </Button>
      </div>
    </div>
  );
}

export function ProvidersPauseControl({ channel }: { channel: DispatchChannel }) {
  // Mostra um botão "Pausar" quando NÃO está pausado, para uso futuro.
  const fetchState = useServerFn(getDispatchPauseState);
  const togglePause = useServerFn(setDispatchPause);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["dispatch-pause-state"],
    queryFn: () => fetchState(),
    refetchInterval: 30_000,
  });

  const mut = useMutation({
    mutationFn: () =>
      togglePause({
        data: { channel, paused: true, reason: "Pausa manual" },
      }),
    onSuccess: () => {
      toast.success(`Disparos de ${LABEL[channel]} pausados.`);
      qc.invalidateQueries({ queryKey: ["dispatch-pause-state"] });
    },
  });

  if (data?.[channel]?.paused) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
      <Pause className="h-3.5 w-3.5 mr-1.5" /> Pausar disparos
    </Button>
  );
}
