import { DEFAULT_CURRENCY, formatMoney, type TenantCurrency } from "@/lib/currency";
import type { LevelSlug, PaidLevelSlug } from "@/lib/gamification.functions";

export const PAID_LEVELS: PaidLevelSlug[] = ["bronze", "silver", "gold", "diamond", "black"];

/** Destino único de "Criar campanha" nesta tela (C-10). */
export const NEW_CAMPAIGN_SEARCH = { newCampaign: 1 } as never;

/** Faixa na moeda da casa; sem centavos quando o valor é inteiro. */
function money(value: number, currency: TenantCurrency) {
  return formatMoney(value, currency, Number.isInteger(value) ? { decimals: 0 } : {});
}

/** Faixa de depósito de um nível, a partir das faixas salvas (na moeda da casa). */
export function levelRange(
  slug: LevelSlug,
  thresholds: Record<PaidLevelSlug, number>,
  currency: TenantCurrency = DEFAULT_CURRENCY,
) {
  if (slug === "novice") return `abaixo de ${money(thresholds.bronze, currency)}`;
  const index = PAID_LEVELS.indexOf(slug);
  const next = PAID_LEVELS[index + 1];
  if (!next) return `${money(thresholds[slug], currency)} ou mais`;
  return `${money(thresholds[slug], currency)} a ${money(thresholds[next], currency)}`;
}

export function lastDepositText(days: number | null) {
  if (days == null) return "sem depósito";
  if (days === 0) return "depositou hoje";
  return `último depósito há ${days} ${days === 1 ? "dia" : "dias"}`;
}
