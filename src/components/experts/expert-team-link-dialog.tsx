// "Vincular a alguém da equipe" dialog (Área do Expert, Fase 3, Task 7):
// links a profile without user to an admin/gestor/membro of the house as a
// performance profile (`linkExpertToTeamMember`). The person keeps their own
// role; the profile only measures. Server refusals reach the admin as a
// toast with the server's pt-BR message.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAPEL_EQUIPE_LABEL } from "@/components/experts/expert-badges";
import { EXPERTS_QUERY_KEY } from "@/components/experts/experts-query";
import { linkExpertToTeamMember, listTeamMembersForLinking } from "@/lib/experts-admin.functions";

export function ExpertTeamLinkDialog({
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
  const listFn = useServerFn(listTeamMembersForLinking);
  const linkFn = useServerFn(linkExpertToTeamMember);
  const [userId, setUserId] = useState("");

  useEffect(() => {
    if (open) setUserId("");
  }, [open]);

  const membersQuery = useQuery({
    queryKey: [...EXPERTS_QUERY_KEY, "team-members-for-linking"],
    queryFn: () => listFn(),
    enabled: open,
  });
  const members = membersQuery.data ?? [];

  const link = useMutation({
    mutationFn: () => {
      if (!expertId) throw new Error("Expert não encontrado.");
      return linkFn({ data: { expertId, userId } });
    },
    onSuccess: () => {
      toast.success("Perfil vinculado");
      qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vincular {expertNome} a alguém da equipe</DialogTitle>
          <DialogDescription>
            O perfil passa a medir o rendimento dessa pessoa. O acesso dela à casa não muda.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="expert-team-member">Pessoa da equipe</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="expert-team-member">
              <SelectValue
                placeholder={membersQuery.isLoading ? "Carregando equipe…" : "Escolha uma pessoa"}
              />
            </SelectTrigger>
            <SelectContent>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.email} · {PAPEL_EQUIPE_LABEL[member.papel]}
                </SelectItem>
              ))}
              {!membersQuery.isLoading && members.length === 0 && (
                <p className="px-2 py-1.5 text-label text-muted-foreground">
                  Ninguém da equipe sem perfil.
                </p>
              )}
            </SelectContent>
          </Select>
          {membersQuery.error && (
            <p className="text-label text-destructive">{membersQuery.error.message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!userId || link.isPending} onClick={() => link.mutate()}>
            {link.isPending ? "Vinculando…" : "Vincular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
