// Excluir jornada, shared by Automações (list) and the journey editor: the
// same confirmation, words and toast in both places.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { deleteJourney } from "@/lib/journeys.functions";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { requestConfirmation } from "@/components/system-dialog-host";

type DeleteTarget = {
  id: string;
  name: string;
  /** "active" says in the confirmation that sending stops now. */
  status: string;
  /** Players inside the journey now; shown in the confirmation when > 0. */
  inProgress?: number;
};

function deleteDescription({ name, status, inProgress = 0 }: DeleteTarget) {
  const people =
    inProgress > 0
      ? ` Os ${inProgress.toLocaleString("pt-BR")} jogadores que estão nela agora saem da jornada e não recebem mais nada dela.`
      : "";
  const stops =
    status === "active"
      ? `A jornada “${name}” está ativa: ao excluir, ela para de enviar na hora.`
      : `A jornada “${name}” será excluída.`;
  return `${stops}${people} Ela some da lista e não pode ser recuperada. Os envios, cliques e o recuperado que ela já gerou continuam nos relatórios.`;
}

/**
 * `canDelete` is false for roles the server refuses (only the house admin
 * and super admin may delete). `requestDelete` confirms, then deletes;
 * `onDeleted` runs after the list is refreshed.
 */
export function useJourneyDelete(options: { onDeleted?: () => void } = {}) {
  const queryClient = useQueryClient();
  const { active } = useActiveTenant();
  const remove = useServerFn(deleteJourney);
  const mutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: ["journey", id] });
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      toast.success("Jornada excluída");
      options.onDeleted?.();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const requestDelete = async (target: DeleteTarget) => {
    const confirmed = await requestConfirmation({
      title: "Excluir jornada?",
      description: deleteDescription(target),
      confirmLabel: "Excluir jornada",
      destructive: true,
    });
    if (confirmed) mutation.mutate(target.id);
  };
  return {
    canDelete: active?.role === "admin" || active?.role === "super_admin",
    requestDelete,
    isPending: mutation.isPending,
  };
}
