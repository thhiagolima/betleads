import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { META_TEXTS } from "@/components/integrations/meta-connection-model";
import {
  connectMetaSystemUserToken,
  disconnectMetaConnection,
  enqueueMetaSync,
  renameMetaConnection,
  updateMetaAccountSelection,
  validateMetaConnection,
} from "@/lib/meta.functions";
import { plural } from "./meta-format";

/** Erro do RPC `meta_select_accounts` quando a lista mudou depois que a tela abriu. */
export const STALE_SELECTION_RPC_MESSAGE =
  "Uma das contas selecionadas não pertence à sua operação.";

export function isStaleSelectionError(error: unknown) {
  return error instanceof Error && error.message === STALE_SELECTION_RPC_MESSAGE;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** "Chave “Agência X” conectada: 2 BMs, 5 contas (3 novas)." (MB3-09) */
export function connectResultMessage(result: {
  created: boolean;
  businesses: number;
  accountsTotal: number;
  accountsNew: number;
  userName: string | null;
  app: { name: string | null };
}) {
  const title = result.userName ?? result.app.name ?? "Meta";
  return `Chave “${title}” ${result.created ? "conectada" : "atualizada"}: ${plural(
    result.businesses,
    "BM",
    "BMs",
  )}, ${plural(result.accountsTotal, "conta", "contas")} (${plural(
    result.accountsNew,
    "nova",
    "novas",
  )}). Marque as que deseja acompanhar e salve.`;
}

/** As mutações da aba Meta Ads, com os toasts e as invalidações de sempre. */
export function useMetaActions() {
  const qc = useQueryClient();
  const connectFn = useServerFn(connectMetaSystemUserToken);
  const selectFn = useServerFn(updateMetaAccountSelection);
  const validateFn = useServerFn(validateMetaConnection);
  const disconnectFn = useServerFn(disconnectMetaConnection);
  const renameFn = useServerFn(renameMetaConnection);
  const syncFn = useServerFn(enqueueMetaSync);

  const refreshSummary = () => qc.invalidateQueries({ queryKey: ["meta-connection-summary"] });
  const refreshAll = () => {
    refreshSummary();
    qc.invalidateQueries({ queryKey: ["marketing-overview"] });
  };

  const connect = useMutation({
    mutationFn: (accessToken: string) => connectFn({ data: { accessToken } }),
    onSuccess: (result) => {
      toast.success(connectResultMessage(result));
      refreshAll();
    },
    onError: (e) =>
      toast.error(errorMessage(e, "Não foi possível validar a chave de acesso da Meta")),
  });

  const select = useMutation({
    mutationFn: (accountIds: string[]) => selectFn({ data: { accountIds } }),
    onSuccess: (result) => {
      toast.success(
        `${plural(result.selected, "conta marcada", "contas marcadas")}${
          result.added > 0 ? ", a importação dos últimos 90 dias começou" : ""
        }`,
      );
      qc.invalidateQueries({ queryKey: ["marketing-overview"] });
      qc.invalidateQueries({ queryKey: ["meta-sync-runs"] });
      // Devolve a releitura do resumo: a mutation só termina (e o Salvar só volta)
      // quando o salvo já mostra a nova seleção; sem isso, o rascunho ficaria
      // "sujo" por um instante e daria para salvar de novo.
      return refreshSummary();
    },
    onError: (e) => {
      // A lista mudou (redescoberta, chave desconectada): relê e pede para revisar.
      if (isStaleSelectionError(e)) {
        refreshSummary();
        toast.error(META_TEXTS.listChanged);
        return;
      }
      toast.error(errorMessage(e, "Não foi possível salvar as contas"));
    },
  });

  const validate = useMutation({
    mutationFn: (connectionId: string) => validateFn({ data: { connectionId } }),
    onSuccess: (result) => {
      toast.success(
        `Acesso testado · ${plural(result.accounts, "conta acessível", "contas acessíveis")}${
          result.accountsNew > 0 ? ` (${plural(result.accountsNew, "nova", "novas")})` : ""
        }`,
      );
      refreshSummary();
    },
    onError: (e) => {
      toast.error(errorMessage(e, "Não foi possível testar o acesso"));
      refreshSummary();
    },
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) => disconnectFn({ data: { connectionId } }),
    onSuccess: (result) => {
      const parts = [
        result.accountsMoved > 0
          ? `${plural(result.accountsMoved, "conta segue", "contas seguem")} por outra chave`
          : null,
        result.accountsStopped > 0
          ? `${plural(result.accountsStopped, "conta parou", "contas pararam")} de sincronizar`
          : null,
      ].filter(Boolean);
      toast.success(`Chave desconectada${parts.length ? `. ${parts.join("; ")}.` : ""}`);
      refreshAll();
    },
    onError: (e) => toast.error(errorMessage(e, "Não foi possível desconectar")),
  });

  const rename = useMutation({
    mutationFn: (input: { connectionId: string; label: string }) => renameFn({ data: input }),
    onSuccess: (result) => {
      toast.success(`Chave renomeada para “${result.label}”`);
      refreshSummary();
    },
    onError: (e) => toast.error(errorMessage(e, "Não foi possível renomear a chave")),
  });

  const sync = useMutation({
    mutationFn: () => syncFn({ data: { days: 7 } }),
    onSuccess: (run) => {
      toast.success(
        run.reused ? "A sincronização já está na fila" : "Sincronização adicionada à fila",
      );
      qc.invalidateQueries({ queryKey: ["meta-sync-runs"] });
      refreshSummary();
    },
    onError: (e) => toast.error(errorMessage(e, "Erro ao agendar sincronização")),
  });

  return { connect, select, validate, disconnect, rename, sync };
}

export type MetaActions = ReturnType<typeof useMetaActions>;
