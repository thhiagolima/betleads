// Contato, retorno e "assumir lead" da ficha do lead (Área do Expert, Fase 2,
// Task 7). Erros das ações aparecem com a mensagem do servidor (pt-BR).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  claimExpertLead,
  completeExpertFollowup,
  logExpertContact,
  releaseExpertLead,
  scheduleExpertFollowup,
} from "@/lib/expert-lead-actions.functions";
import { CONTATO_LABEL, CONTATO_RESULTADOS, type ContatoResultado } from "@/lib/expert-lead-labels";
import type { ExpertLeadSheet } from "@/lib/expert-lead-sheet";

import { ActionCard } from "./lead-actions";
import { actionErrorMessage, brtToday, formatBrtDdMm, formatDueDate } from "./sheet-format";

const NOTE_MAX = 1000;
const fieldClass = "h-11 sm:h-9";

export function LeadContactPanel({
  sheet,
  onChanged,
}: {
  sheet: ExpertLeadSheet;
  onChanged: () => void;
}) {
  const playerId = sheet.lead.id;

  // ---------------------------------------------------------------- contact
  const [contactNote, setContactNote] = useState("");
  const logContactFn = useServerFn(logExpertContact);
  const logContact = useMutation({
    mutationFn: (resultado: ContatoResultado) =>
      logContactFn({
        data: { playerId, resultado, nota: contactNote.trim() || undefined },
      }),
    onSuccess: () => {
      setContactNote("");
      toast.success("Contato registrado.");
      onChanged();
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  // ---------------------------------------------------------------- follow-up
  const today = brtToday();
  const [dueDate, setDueDate] = useState("");
  const [followupNote, setFollowupNote] = useState("");
  const scheduleFn = useServerFn(scheduleExpertFollowup);
  const schedule = useMutation({
    mutationFn: () =>
      scheduleFn({
        data: { playerId, dueDate, nota: followupNote.trim() || undefined },
      }),
    onSuccess: () => {
      setDueDate("");
      setFollowupNote("");
      toast.success("Retorno agendado.");
      onChanged();
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  const completeFn = useServerFn(completeExpertFollowup);
  const complete = useMutation({
    mutationFn: (id: string) => completeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Retorno concluído.");
      onChanged();
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  // ---------------------------------------------------------------- claim
  const claimFn = useServerFn(claimExpertLead);
  const claim = useMutation({
    mutationFn: () => claimFn({ data: { playerId } }),
    onSuccess: () => {
      toast.success("Lead assumido.");
      onChanged();
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error));
      // Outro expert pode ter assumido nesse meio-tempo: atualiza o aviso.
      onChanged();
    },
  });

  const releaseFn = useServerFn(releaseExpertLead);
  const release = useMutation({
    mutationFn: () => releaseFn({ data: { playerId } }),
    onSuccess: () => {
      toast.success("Lead liberado.");
      onChanged();
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  const currentClaim = sheet.claim;

  return (
    <div className="space-y-3">
      <ActionCard title="Registrar contato">
        <div className="grid grid-cols-2 gap-2">
          {CONTATO_RESULTADOS.map((resultado) => (
            <Button
              key={resultado}
              variant="outline"
              className={fieldClass}
              disabled={logContact.isPending}
              onClick={() => logContact.mutate(resultado)}
            >
              {CONTATO_LABEL[resultado]}
            </Button>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expert-contact-note">Nota (opcional)</Label>
          <Textarea
            id="expert-contact-note"
            rows={2}
            maxLength={NOTE_MAX}
            value={contactNote}
            onChange={(event) => setContactNote(event.target.value)}
          />
        </div>
      </ActionCard>

      <ActionCard title="Agendar retorno">
        <div className="space-y-1.5">
          <Label htmlFor="expert-followup-date">Data</Label>
          <Input
            id="expert-followup-date"
            type="date"
            min={today}
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expert-followup-note">Nota (opcional)</Label>
          <Textarea
            id="expert-followup-note"
            rows={2}
            maxLength={NOTE_MAX}
            value={followupNote}
            onChange={(event) => setFollowupNote(event.target.value)}
          />
        </div>
        <Button
          className={`${fieldClass} w-full`}
          disabled={!dueDate || schedule.isPending}
          onClick={() => schedule.mutate()}
        >
          {schedule.isPending ? "Agendando…" : "Agendar retorno"}
        </Button>
        {sheet.retornosPendentes.length > 0 && (
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {sheet.retornosPendentes.map((retorno) => (
              <li key={retorno.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p
                    className={
                      retorno.dueDate < today
                        ? "text-body font-medium text-warning"
                        : "text-body font-medium"
                    }
                  >
                    {formatDueDate(retorno.dueDate)}
                  </p>
                  {retorno.nota && (
                    <p className="mt-0.5 break-words text-label text-muted-foreground">
                      {retorno.nota}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className={fieldClass}
                  disabled={complete.isPending}
                  onClick={() => complete.mutate(retorno.id)}
                >
                  Concluir
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ActionCard>

      {sheet.podeAssumir && (
        <ActionCard title="Assumir lead">
          {currentClaim && !currentClaim.minha ? (
            <p className="text-body text-warning">
              Em atendimento por {currentClaim.expertNome} até{" "}
              {formatBrtDdMm(currentClaim.expiresAt)}
            </p>
          ) : currentClaim?.minha ? (
            <p className="flex flex-wrap items-center gap-x-1.5 text-body">
              <span>Você assumiu até {formatBrtDdMm(currentClaim.expiresAt)}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="-my-2 inline-flex min-h-11 items-center font-medium text-primary hover:underline disabled:opacity-50 sm:min-h-0"
                disabled={release.isPending}
                onClick={() => release.mutate()}
              >
                Liberar
              </button>
            </p>
          ) : (
            <Button
              className={`${fieldClass} w-full`}
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {claim.isPending ? "Assumindo…" : "Assumir lead"}
            </Button>
          )}
        </ActionCard>
      )}
    </div>
  );
}
