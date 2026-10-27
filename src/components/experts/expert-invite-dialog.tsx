// "Convidar" dialog (Área do Expert, Fase 1, Task 8): sends an invite to the
// expert's e-mail via `inviteExpert` (Task 6). Server-side refusals (already
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteExpert } from "@/lib/experts-admin.functions";
import { EXPERTS_QUERY_KEY } from "@/components/experts/experts-query";

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

  useEffect(() => {
    if (open) setEmail("");
  }, [open]);

  const invite = useMutation({
    mutationFn: () => {
      if (!expertId) throw new Error("Expert não encontrado.");
      return inviteFn({ data: { expertId, email } });
    },
    onSuccess: () => {
      toast.success("Convite enviado");
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
            Enviamos um convite de acesso para o e-mail informado.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>E-mail</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="expert@exemplo.com"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!email.trim() || invite.isPending} onClick={() => invite.mutate()}>
            {invite.isPending ? "Enviando…" : "Convidar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
