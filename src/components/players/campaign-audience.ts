import { toast } from "sonner";

export type CampaignRecipient = { phone: string; playerId?: string };

/**
 * Hands an audience of players to the campaign composer: stores the draft that
 * /campanhas?newCampaign=1&draft=players reads and opens the composer.
 * Same draft the Jogadores list has always written (D-04).
 */
export function openCampaignWithAudience(args: {
  label: string;
  recipients: CampaignRecipient[];
  missingPhone: number;
}) {
  const unique = new Map<string, CampaignRecipient>();
  for (const recipient of args.recipients) {
    const phone = recipient.phone.replace(/\D/g, "");
    if (phone.length >= 10 && !unique.has(phone)) unique.set(phone, { ...recipient, phone });
  }
  const recipients = Array.from(unique.values());
  if (recipients.length === 0) {
    toast.error("Nenhum jogador com telefone válido neste público.");
    return;
  }
  window.localStorage.setItem(
    "betleads:campaignAudienceDraft",
    JSON.stringify({
      source: "players",
      label: args.label,
      recipients,
      missingPhone: args.missingPhone,
      createdAt: new Date().toISOString(),
    }),
  );
  toast.success(
    recipients.length === 1
      ? "1 jogador pronto para a campanha."
      : `${recipients.length.toLocaleString("pt-BR")} jogadores prontos para a campanha.`,
  );
  window.location.assign("/campanhas?newCampaign=1&draft=players");
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
