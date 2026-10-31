import { useEffect, useMemo, useState } from "react";

import { selectionDiff } from "@/components/integrations/meta-connection-model";

// API do hook:
//   useSelectionDraft(persistedIds: readonly string[], visibleIds?: readonly string[])
// `visibleIds` (opcional) são os ids das linhas que a tela mostra (de
// `buildAccountRows`, sem filtro nem busca). Com ele, uma marcação não salva de
// conta que sumiu da tela (ex.: chave desconectada) sai do rascunho. Sem ele,
// nada é podado. O retorno é o mesmo de antes: { draft, persisted, diff, setDraft, discard }.

export function selectionKey(ids: Iterable<string>) {
  return [...ids].sort().join(",");
}

export type DraftState = {
  /** A seleção salva de onde o rascunho partiu. */
  base: Set<string>;
  draft: Set<string>;
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * O salvo mudou (polling, outro admin, o próprio Salvar): merge de 3 vias. As
 * marcações e desmarcações deste usuário (rascunho − base / base − rascunho) são
 * reaplicadas sobre o novo salvo, sem apagar o que outro admin mudou. Depois,
 * sai do rascunho o id que não está salvo e não tem linha na tela (não daria
 * para mostrar nem salvar). Sem mudança, devolve o mesmo objeto.
 */
export function reconcileDraft(
  prev: { base: Set<string>; draft: Set<string> },
  persisted: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): { base: Set<string>; draft: Set<string> } {
  const baseChanged = !sameSet(prev.base, persisted);
  let merged: Set<string>;
  if (baseChanged) {
    merged = new Set(persisted);
    for (const id of prev.draft) if (!prev.base.has(id)) merged.add(id);
    for (const id of prev.base) if (!prev.draft.has(id)) merged.delete(id);
  } else {
    merged = prev.draft;
  }
  const pruned = [...merged].filter((id) => persisted.has(id) || visibleIds.has(id));
  if (!baseChanged && pruned.length === prev.draft.size) return prev;
  return { base: baseChanged ? new Set(persisted) : prev.base, draft: new Set(pruned) };
}

/**
 * Rascunho da seleção de contas (MB3-03). Começa igual ao que está salvo e não é
 * sobrescrito pelo polling: quando o salvo muda, as alterações deste usuário são
 * reaplicadas sobre ele (`reconcileDraft`). Com alterações pendentes, avisa ao
 * sair da aba. `diff` (contagem de mudanças) usa o rascunho já podado.
 */
export function useSelectionDraft(persistedIds: readonly string[], visibleIds?: readonly string[]) {
  const persistedKey = selectionKey(persistedIds);
  const visibleKey = visibleIds ? selectionKey(visibleIds) : null;
  // Os Sets só mudam quando o conteúdo muda (o polling devolve arrays novos a cada 30 s).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const persisted = useMemo(() => new Set(persistedIds), [persistedKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visible = useMemo(() => (visibleIds ? new Set(visibleIds) : null), [visibleKey]);
  const [state, setState] = useState<DraftState>(() => ({
    base: new Set(persisted),
    draft: new Set(persisted),
  }));

  // Ajuste durante o render (sem efeito): o salvo ou as linhas mudaram.
  const current = reconcileDraft(state, persisted, visible ?? state.draft);
  if (current !== state) setState(current);

  const diff = selectionDiff(persisted, current.draft);

  useEffect(() => {
    if (!diff.dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome antigo só mostra o aviso com returnValue preenchido.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [diff.dirty]);

  return {
    draft: current.draft as ReadonlySet<string>,
    persisted: persisted as ReadonlySet<string>,
    diff,
    setDraft: (next: ReadonlySet<string>) =>
      setState((prev) => ({ ...prev, draft: new Set(next) })),
    discard: () => setState({ base: new Set(persisted), draft: new Set(persisted) }),
  };
}
