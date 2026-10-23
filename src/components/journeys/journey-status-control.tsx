// Ativar / Pausar a journey, shared by Automações (list) and the journey editor:
// the same confirmation dialogs, words and toasts in both places.

import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { getJourneyActivationEstimate, setJourneyStatus } from "@/lib/journeys.functions";
import {
  activationAsksEntryScope,
  defaultEntryScope,
  type JourneyEntryScope,
} from "@/lib/journey-policy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type StatusTarget = { id: string; name: string };

function ChoiceCard({
  value,
  id,
  title,
  children,
}: {
  value: string;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary/50">
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <Label htmlFor={id} className="cursor-pointer space-y-1 font-normal leading-snug">
        <span className="block font-medium">{title}</span>
        <span className="block text-[13px] text-muted-foreground">{children}</span>
      </Label>
    </div>
  );
}

/**
 * `requestActivate` asks who may enter (when the trigger needs it) and
 * `requestPause` always confirms, describing who is inside the journey now.
 * Render `dialogs` once in the page.
 */
export function useJourneyStatusControl() {
  const queryClient = useQueryClient();
  const changeStatus = useServerFn(setJourneyStatus);
  const estimateFn = useServerFn(getJourneyActivationEstimate);
  const [pauseCandidate, setPauseCandidate] = useState<
    (StatusTarget & { inProgress: number }) | null
  >(null);
  const [closeOnPause, setCloseOnPause] = useState(false);
  const [activateCandidate, setActivateCandidate] = useState<StatusTarget | null>(null);
  const [entryScope, setEntryScope] = useState<JourneyEntryScope>("new_only");
  const estimate = useQuery({
    queryKey: ["journey-activation-estimate", activateCandidate?.id],
    queryFn: () => estimateFn({ data: { id: activateCandidate!.id } }),
    enabled: Boolean(activateCandidate),
    staleTime: 60_000,
  });
  const status = useMutation({
    mutationFn: (input: {
      id: string;
      status: "active" | "paused";
      entryScope?: JourneyEntryScope;
      closeEnrollments?: boolean;
    }) => changeStatus({ data: input }),
    onSuccess: async (result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["journeys"] }),
        queryClient.invalidateQueries({ queryKey: ["journey", variables.id] }),
      ]);
      setPauseCandidate(null);
      setActivateCandidate(null);
      toast.success(
        variables.status === "active"
          ? "Jornada ativada"
          : result.closed
            ? `Jornada pausada · ${result.closed.toLocaleString("pt-BR")} jogador(es) saíram da jornada`
            : "Jornada pausada",
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const requestActivate = (journey: StatusTarget & { trigger_type: string }) => {
    if (!activationAsksEntryScope(journey.trigger_type)) {
      status.mutate({ id: journey.id, status: "active" });
      return;
    }
    setEntryScope(defaultEntryScope(journey.trigger_type));
    setActivateCandidate({ id: journey.id, name: journey.name });
  };
  const requestPause = (journey: StatusTarget & { inProgress: number }) => {
    setCloseOnPause(false);
    setPauseCandidate(journey);
  };

  const dialogs = (
    <>
      <Dialog
        open={pauseCandidate !== null}
        onOpenChange={(open) => !open && !status.isPending && setPauseCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pausar “{pauseCandidate?.name}”?</DialogTitle>
            <DialogDescription>
              {pauseCandidate?.inProgress
                ? `${pauseCandidate.inProgress.toLocaleString("pt-BR")} jogador(es) estão nesta jornada agora. Nenhuma mensagem sai enquanto ela estiver pausada, e ninguém novo entra.`
                : "Ninguém está nesta jornada agora. Enquanto ela estiver pausada, ninguém novo entra."}
            </DialogDescription>
          </DialogHeader>
          {Boolean(pauseCandidate?.inProgress) && (
            <RadioGroup
              aria-label="O que fazer com quem está na jornada"
              value={closeOnPause ? "close" : "keep"}
              onValueChange={(value) => setCloseOnPause(value === "close")}
              className="gap-3 text-sm"
            >
              <ChoiceCard value="keep" id="pause-keep" title="Manter os jogadores">
                Ao ativar de novo, cada um continua de onde parou. Etapas atrasadas respeitam o
                limite de mensagens por pessoa.
              </ChoiceCard>
              <ChoiceCard value="close" id="pause-close" title="Encerrar a participação de todos">
                Todos saem da jornada agora. Ao ativar de novo, só entra quem cumprir o gatilho de
                novo.
              </ChoiceCard>
            </RadioGroup>
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
              {closeOnPause ? "Pausar e encerrar" : "Pausar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={activateCandidate !== null}
        onOpenChange={(open) => !open && !status.isPending && setActivateCandidate(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ativar “{activateCandidate?.name}”</DialogTitle>
            <DialogDescription>Quem pode entrar nesta jornada?</DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="Quem pode entrar"
            value={entryScope}
            onValueChange={(value) => setEntryScope(value as JourneyEntryScope)}
            className="gap-3 text-sm"
          >
            <ChoiceCard value="new_only" id="scope-new" title="Só casos novos, a partir de agora">
              Ninguém da base atual entra. Quem já estava na jornada sai na próxima verificação.
            </ChoiceCard>
            <ChoiceCard value="include_base" id="scope-base" title="Incluir a base atual">
              Jogadores que já cumprem o gatilho entram nos próximos minutos e recebem a primeira
              etapa, dentro do limite de mensagens por pessoa.
              {estimate.isLoading ? (
                <span className="mt-1 block text-xs">Calculando o impacto…</span>
              ) : estimate.data?.supported && estimate.data.eligible != null ? (
                <span className="mt-1 block text-xs font-medium text-foreground">
                  ≈ {estimate.data.eligible.toLocaleString("pt-BR")} jogador(es) entram agora · 1º
                  envio ≈{" "}
                  {(estimate.data.firstSendCost ?? 0).toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  })}
                  {estimate.data.eligible > 0 &&
                    " · se a jornada envia todo dia, o custo se repete a cada dia"}
                </span>
              ) : null}
            </ChoiceCard>
          </RadioGroup>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={status.isPending}
              onClick={() => setActivateCandidate(null)}
            >
              Cancelar
            </Button>
            <Button
              disabled={status.isPending || !activateCandidate}
              onClick={() =>
                activateCandidate &&
                status.mutate({ id: activateCandidate.id, status: "active", entryScope })
              }
            >
              <Play className="mr-1 h-4 w-4" aria-hidden="true" /> Ativar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { requestActivate, requestPause, isPending: status.isPending, dialogs };
}
