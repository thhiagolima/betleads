// pt-BR labels for the link tracking overview rows (channel and source of the send).

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  email: "E-mail",
  whatsapp: "WhatsApp",
};

const SOURCE_LABELS: Record<string, string> = {
  campaign: "Campanha",
  journey: "Automação",
  manual: "Envio manual",
  expert: "Expert (WhatsApp manual)",
};

function fallback(value: string | null | undefined): string {
  const clean = (value ?? "").trim();
  if (!clean) return "Não informado";
  return clean.charAt(0).toUpperCase() + clean.slice(1).replace(/_/g, " ");
}

/** "sms" → "SMS". Unknown values are shown capitalized instead of raw. */
export function linkChannelLabel(channel: string | null | undefined): string {
  return CHANNEL_LABELS[(channel ?? "").trim().toLowerCase()] ?? fallback(channel);
}

/** "journey" → "Automação". Unknown values are shown capitalized instead of raw. */
export function linkSourceLabel(source: string | null | undefined): string {
  return SOURCE_LABELS[(source ?? "").trim().toLowerCase()] ?? fallback(source);
}

/** "SMS · Automação" */
export function linkOriginLabel(
  channel: string | null | undefined,
  source: string | null | undefined,
): string {
  return `${linkChannelLabel(channel)} · ${linkSourceLabel(source)}`;
}
