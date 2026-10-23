import type { LevelSlug, PaidLevelSlug } from "@/lib/gamification.functions";

export const PAID_LEVELS: PaidLevelSlug[] = ["bronze", "silver", "gold", "diamond", "black"];

/** Destino único de "Criar campanha" nesta tela (C-10). */
export const NEW_CAMPAIGN_SEARCH = { newCampaign: 1 } as never;

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** Faixa de depósito de um nível, a partir das faixas salvas. */
export function levelRange(slug: LevelSlug, thresholds: Record<PaidLevelSlug, number>) {
  if (slug === "novice") return `abaixo de ${money(thresholds.bronze)}`;
  const index = PAID_LEVELS.indexOf(slug);
  const next = PAID_LEVELS[index + 1];
  if (!next) return `${money(thresholds[slug])} ou mais`;
  return `${money(thresholds[slug])} a ${money(thresholds[next])}`;
}

export function lastDepositText(days: number | null) {
  if (days == null) return "sem depósito";
  if (days === 0) return "depositou hoje";
  return `último depósito há ${days} ${days === 1 ? "dia" : "dias"}`;
}
