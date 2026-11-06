// "Convidar" dialog (Área do Expert, Fase 1, Task 8): gives the expert a login
// via `inviteExpert` (Task 6) — an e-mail invite, or (when e-mail delivery is a
// problem) a temporary password set right here, with no e-mail. Server-side refusals (already
// has access, e-mail taken by another role, demo tenant, …) reach the admin
// as a toast with the server's own pt-BR message.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { inviteExpert } from "@/lib/experts-admin.functions";
import { EXPERTS_QUERY_KEY } from "@/components/experts/experts-query";
import { ExpertAccessFields } from "@/components/experts/expert-access-fields";
import {
  canSubmitExpertAccess,
  expertAccessFeedback,
  expertAccessPassword,
  type ExpertAccessMode,
} from "@/components/experts/expert-access-model";

export function ExpertInviteDialog({
  open,
  onOpenChange,
  expertId,
  expertNome,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expertId: string | null;
  expertNome: string;
}) {
  const qc = useQueryClient();
  const inviteFn = useServerFn(inviteExpert);
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<ExpertAccessMode>("convite");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setMode("convite");
    setPassword("");
  }, [open]);

  const invite = useMutation({
    mutationFn: () => {
      if (!expertId) throw new Error("Expert não encontrado.");
      return inviteFn({
        data: { expertId, email: email.trim(), password: expertAccessPassword(mode, password) },
      });
    },
    onSuccess: (result) => {
      const feedback = expertAccessFeedback(result);
      if (feedback.kind === "info") toast.info(feedback.message);
      else toast.success(feedback.message);
      qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar {expertNome}</DialogTitle>
          <DialogDescription>
            {mode === "senha"
              ? "Criamos o login com o e-mail e a senha informados."
              : "Enviamos um convite de acesso para o e-mail informado."}
          </DialogDescription>
        </DialogHeader>
        <ExpertAccessFields
          email={email}
          onEmailChange={setEmail}
          mode={mode}
          onModeChange={setMode}
          password={password}
          onPasswordChange={setPassword}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!canSubmitExpertAccess(email, mode, password) || invite.isPending}
            onClick={() => invite.mutate()}
          >
            {invite.isPending
              ? mode === "senha"
                ? "Criando…"
                : "Enviando…"
              : mode === "senha"
                ? "Criar acesso"
                : "Convidar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
