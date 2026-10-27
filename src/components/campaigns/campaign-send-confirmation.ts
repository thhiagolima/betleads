import { brl, num } from "@/lib/format";

/** Acima deste número de destinatários, o envio exige digitar a quantidade. */
export const TYPED_CONFIRMATION_THRESHOLD = 1000;

export type CampaignSendChannel = "sms" | "email" | "voice";

/**
 * Tudo o que a revisão de risco cobre. Quando qualquer item muda, a
 * confirmação marcada antes deixa de valer e precisa ser refeita.
 */
export type CampaignRiskInputs = {
  channel: CampaignSendChannel;
  audienceId: string;
  recipients: number;
  sendableRecipients: number;
  cost: number;
  smsContent: string;
  smsTemplateId: string;
  emailTemplateId: string;
  voiceMode: string;
  voiceSourceId: string;
  when: "now" | "schedule";
  scheduledAt: string;
};

export function campaignRiskSignature(inputs: CampaignRiskInputs): string {
  return JSON.stringify([
    inputs.channel,
    inputs.audienceId,
    inputs.recipients,
    inputs.sendableRecipients,
    inputs.cost,
    inputs.smsContent,
    inputs.smsTemplateId,
    inputs.emailTemplateId,
    inputs.voiceMode,
    inputs.voiceSourceId,
    inputs.when,
    inputs.when === "schedule" ? inputs.scheduledAt : "",
  ]);
}

export function requiresTypedConfirmation(recipients: number): boolean {
  return recipients > TYPED_CONFIRMATION_THRESHOLD;
}

/** Aceita "12430", "12.430" ou "12 430" para a quantidade 12.430. */
export function typedCountMatches(input: string | null | undefined, recipients: number): boolean {
  if (!input) return false;
  const trimmed = input.trim();
  if (!/^[\d.\s]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/[.\s]/g, "");
  return digits.length > 0 && Number(digits) === recipients;
}

function players(count: number) {
  return `${num(count)} ${count === 1 ? "jogador" : "jogadores"}`;
}

/**
 * Texto do botão final: diz a quem vai e quanto custa, em R$, não em
 * "créditos" (PG1 final review). Só o SMS tem custo diferente da
 * quantidade de destinatários (mensagens longas usam mais de um segmento),
 * e a casa isenta (`interno`) não paga nada pelo envio.
 */
export function campaignSendLabel({
  channel,
  when,
  recipients,
  cost,
  smsUnitPrice,
  smsExempt,
}: {
  channel: CampaignSendChannel;
  when: "now" | "schedule";
  recipients: number;
  cost: number;
  /** Preço vigente do segmento de SMS (`getBillingPrices().sms.unitPrice`). */
  smsUnitPrice?: number | null;
  /** Casa isenta (`interno`): não exibe preço, o envio não é cobrado. */
  smsExempt?: boolean;
}): string {
  const verb = when === "schedule" ? "Agendar para" : "Enviar para";
  const base = `${verb} ${players(recipients)}`;
  if (channel === "sms") {
    const segments = `${num(cost)} ${cost === 1 ? "segmento" : "segmentos"}`;
    if (smsExempt) return `${base} · Casa isenta`;
    if (smsUnitPrice != null) return `${base} · ${segments} · ${brl(cost * smsUnitPrice)}`;
    return `${base} · ${segments}`;
  }
  if (channel === "voice") return `${base} · ${num(cost)} ${cost === 1 ? "chamada" : "chamadas"}`;
  return base;
}
