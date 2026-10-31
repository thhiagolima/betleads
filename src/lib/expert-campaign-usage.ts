// Área do Expert §8 — leitura do teto mensal de envios no navegador: o
// cartão "Uso do mês" (/campanhas, início do expert) e o bloqueio do
// compositor. A checagem que vale é a do servidor (reserva atômica); aqui só
// explicamos antes do clique.

import { brl } from "@/lib/format";

/** Same shape as `getExpertCampaignUsage` (expert-campaigns.server.ts). */
export type ExpertCampaignUsageData = {
  teto: number | null;
  usado: number;
  restante: number | null;
  pendentes: number;
  pendentesEstimado: number;
  /** "AAAA-MM". */
  mes: string;
};

export type ExpertUsageState = "sem_teto" | "bloqueado" | "ok" | "alerta" | "atingido";

export type ExpertUsageView = {
  state: ExpertUsageState;
  /** 0–100, null without a cap. */
  percent: number | null;
  /** "Uso do mês: R$ X de R$ Y" (or without the cap). */
  headline: string;
  /** Second line explaining the state; null when nothing needs explaining. */
  detail: string | null;
  /** Tailwind classes of the progress bar fill. */
  barClass: string;
};

/** Alert threshold of the progress bar (amber from here on). */
export const EXPERT_USAGE_ALERT_PERCENT = 80;

/** "2026-10" → "01/11" (first day of the next month). */
export function nextMonthStartLabel(mes: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(mes);
  const month = match ? Number(match[2]) : new Date().getMonth() + 1;
  const next = month === 12 ? 1 : month + 1;
  return `01/${String(next).padStart(2, "0")}`;
}

export function expertCapReachedText(mes: string): string {
  return `Teto atingido; novos envios voltam em ${nextMonthStartLabel(mes)} ou quando o admin aumentar o teto.`;
}

export function expertUsageView(usage: ExpertCampaignUsageData): ExpertUsageView {
  const used = Math.max(0, usage.usado);
  if (usage.teto === null) {
    return {
      state: "sem_teto",
      percent: null,
      headline: `Uso do mês: ${brl(used)}`,
      detail: "Sem teto definido",
      barClass: "bg-primary",
    };
  }
  if (usage.teto <= 0) {
    return {
      state: "bloqueado",
      percent: 100,
      headline: "Envios bloqueados (teto R$ 0)",
      detail: "Fale com o admin da casa para liberar seus envios.",
      barClass: "bg-danger",
    };
  }
  const percent = Math.min(100, Math.round((used / usage.teto) * 100));
  const headline = `Uso do mês: ${brl(used)} de ${brl(usage.teto)}`;
  if (used >= usage.teto - 1e-9 || (usage.restante !== null && usage.restante <= 0)) {
    return {
      state: "atingido",
      percent: 100,
      headline,
      detail: expertCapReachedText(usage.mes),
      barClass: "bg-danger",
    };
  }
  if (percent >= EXPERT_USAGE_ALERT_PERCENT) {
    return { state: "alerta", percent, headline, detail: null, barClass: "bg-warning" };
  }
  return { state: "ok", percent, headline, detail: null, barClass: "bg-primary" };
}

/** "2 aguardando aprovação · R$ 12,00 estimados" (null without pending campaigns). */
export function expertPendingText(usage: ExpertCampaignUsageData): string | null {
  if (usage.pendentes <= 0) return null;
  const count = usage.pendentes === 1 ? "1 campanha" : `${usage.pendentes} campanhas`;
  return `${count} aguardando aprovação · ${brl(usage.pendentesEstimado)} estimados`;
}

/** What is left of the cap after this send (null without a cap). */
export function remainingAfterSend(
  usage: ExpertCampaignUsageData | null | undefined,
  estimatedCost: number,
): number | null {
  if (!usage || usage.teto === null) return null;
  const remaining = usage.restante ?? Math.max(0, usage.teto - usage.usado);
  return remaining - estimatedCost;
}

/** Why the expert cannot submit this campaign because of the cap (null = allowed). */
export function expertCapBlockReason(
  usage: ExpertCampaignUsageData | null | undefined,
  estimatedCost: number,
): string | null {
  if (!usage || usage.teto === null) return null;
  if (usage.teto <= 0)
    return "Seus envios estão bloqueados: o teto mensal é R$ 0,00. Fale com o admin da casa.";
  const remaining = usage.restante ?? Math.max(0, usage.teto - usage.usado);
  if (remaining <= 0) return expertCapReachedText(usage.mes);
  if (estimatedCost > remaining + 1e-9)
    return `Esta campanha custa cerca de ${brl(estimatedCost)}, mas restam ${brl(remaining)} do seu teto mensal. Reduza o público ou peça ao admin para aumentar o teto.`;
  return null;
}

export type ExpertPrices = { sms: number; email: number; voice_30s: number };

/**
 * Estimated cost shown in the expert composer. SMS and e-mail follow the
 * text being typed (segments) without a new request; voice uses the
 * server's estimate (it depends on the audio length and the call ceiling).
 */
export function expertEstimatedCost({
  channel,
  recipients,
  smsSegments,
  prices,
  serverEstimate,
}: {
  channel: "sms" | "email" | "voice";
  recipients: number;
  smsSegments: number;
  prices: ExpertPrices | null | undefined;
  serverEstimate: number | null | undefined;
}): number | null {
  if (recipients <= 0) return 0;
  if (channel === "voice" || !prices) return serverEstimate ?? null;
  const cents = (value: number) => Math.round(value * 10_000) / 10_000;
  if (channel === "sms") return cents(recipients * Math.max(1, smsSegments) * prices.sms);
  return cents(recipients * prices.email);
}

/** React Query key of `getExpertCampaignUsage` (hub, composer, expert home). */
export const EXPERT_USAGE_QUERY_KEY = ["expert-campaign-usage"];
