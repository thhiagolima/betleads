import { toast } from "sonner";
import { createSelectionAudience } from "@/lib/sms-audience-crud.functions";

/**
 * Hands a selection of players to the campaign composer: saves it as a
 * selection audience ("Seleção de Jogadores · dd/mm hh:mm", criteria =
 * player ids of the active house) and opens
 * /campanhas?newCampaign=1&audience=<id> with it selected.
 * Returns false when nothing was opened (empty selection or server error).
 */
export async function openCampaignWithAudience(args: {
  playerIds: string[];
  /** Shown when the filter had more players than the selection cap. */
  truncatedFrom?: number;
}): Promise<boolean> {
  const playerIds = Array.from(new Set(args.playerIds.filter(Boolean)));
  if (playerIds.length === 0) {
    toast.error("Nenhum jogador selecionado.");
    return false;
  }
  try {
    const created = await createSelectionAudience({ data: { playerIds } });
    const count = created.playerCount;
    const ready =
      count === 1
        ? "1 jogador pronto para a campanha."
        : `${count.toLocaleString("pt-BR")} jogadores prontos para a campanha.`;
    const notes: string[] = [];
    if (args.truncatedFrom && args.truncatedFrom > playerIds.length)
      notes.push(
        `O filtro tem ${args.truncatedFrom.toLocaleString("pt-BR")} jogadores; foram usados os ${playerIds.length.toLocaleString("pt-BR")} primeiros por data de cadastro (mais antigos primeiro).`,
      );
    if (created.discarded > 0)
      notes.push(
        `${created.discarded.toLocaleString("pt-BR")} não pertencem a esta casa e ficaram de fora.`,
      );
    if (notes.length) toast.warning(ready, { description: notes.join(" ") });
    else toast.success(ready);
    window.location.assign(`/campanhas?newCampaign=1&audience=${encodeURIComponent(created.id)}`);
    return true;
  } catch (error) {
    toast.error(
      error instanceof Error && error.message
        ? error.message
        : "Não foi possível preparar o público da campanha.",
    );
    return false;
  }
}

/** Copies text, with a textarea fallback for browsers without the async clipboard. */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      // navegador antigo bloqueou o fallback de cópia
    }
    document.body.removeChild(ta);
    return true;
  }
}
