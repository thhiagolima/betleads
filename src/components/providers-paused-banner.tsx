import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  getDispatchPauseState,
  setDispatchPause,
  type DispatchChannel,
} from "@/lib/dispatch-pause.functions";
import { tenantSafeChannelError } from "@/lib/channel-error";
import { requestConfirmation } from "@/components/system-dialog-host";

const LABEL: Record<DispatchChannel, string> = {
  sms: "SMS",
  email: "Email",
  call: "Ligações",
};

/**
 * Translates the stored pause reason into tenant-safe text. Raw reasons can
 * carry provider names and error bodies (e.g. "INSUFFICIENT_FUNDS Short
 * Brasil SMS — ..."), so only known patterns are shown; anything else is
 * omitted rather than leaked.
 */
function pauseReasonLabel(reason: string | null | undefined): string | null {
  const text = reason?.trim();
  if (!text) return null;
  if (/INSUFFICIENT_FUNDS/i.test(text)) return "Saldo esgotado no provedor de envio.";
  if (/manuten[cç][aã]o/i.test(text)) return "Provedor de envio em manutenção.";
  if (/pausa manual/i.test(text)) return "Pausado manualmente.";
  return null;
}

export function ProvidersPausedBanner({ channel }: { channel: DispatchChannel }) {
  const fetchState = useServerFn(getDispatchPauseState);
  const togglePause = useServerFn(setDispatchPause);
  const qc = useQueryClient();

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
  const reasonLabel = pauseReasonLabel(row.reason);

  async function resume() {
    const confirmed = await requestConfirmation({
      title: `Retomar disparos de ${LABEL[channel]}?`,
      description: `Os envios de ${LABEL[channel]} voltam a sair imediatamente: campanhas e pendências que estavam na fila começam a ser processadas nos próximos segundos.`,
      confirmLabel: "Retomar disparos",
    });
    if (confirmed) mut.mutate(false);
  }
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning flex items-start gap-3">
      <Pause className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium">Disparos de {LABEL[channel]} pausados</div>
        {reasonLabel && <div className="text-xs">Motivo: {reasonLabel}</div>}
        <div className="text-xs opacity-80">
          O canal está temporariamente indisponível. Nada foi perdido: campanhas e pendências
          continuam preservadas e serão processadas quando o serviço for retomado.
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="sm"
          onClick={() => void resume()}
          disabled={mut.isPending}
          className="bg-warning text-primary-foreground hover:bg-warning/90"
        >
          <Play className="h-3.5 w-3.5 mr-1.5" /> Retomar disparos
        </Button>
      </div>
    </div>
  );
}
