import { LEVEL_LABEL } from "@/lib/player-level";
import {
  isSelectionAudience,
  selectionAudienceLabel,
  selectionCountOf,
  type SmsAudienceCriteria,
} from "@/lib/sms-audience-criteria";

const TIMING_LABEL: Record<string, string> = {
  cooling: "Esfriando",
  sleeping: "Dormindo",
  inactive30: "30+ dias sem depositar",
  inactive90: "90+ dias sem depositar",
  registered_week: "Cadastro nesta semana",
};

/** Resumo das regras de um público salvo, em etiquetas neutras. */
export function criteriaLabels(criteria: SmsAudienceCriteria): string[] {
  const labels: string[] = [];
  const selection = isSelectionAudience(criteria);
  if (selection) labels.push(selectionAudienceLabel(selectionCountOf(criteria)));
  if (criteria.activity.deposit === "never") labels.push("Nunca depositou");
  if (criteria.activity.deposit === "yes") labels.push("Já depositou");
  if (criteria.activity.pixUnpaid) labels.push("Gerou PIX e não pagou");
  if (criteria.activity.withdrawal === "yes") labels.push("Já sacou");
  if (criteria.activity.withdrawal === "never") labels.push("Nunca sacou");
  if (criteria.activity.withdrawalPending) labels.push("Saque pendente");
  if (criteria.activity.cashback) labels.push("Recebeu cashback");
  if (criteria.level) labels.push(LEVEL_LABEL[criteria.level]);
  if (criteria.timing === "custom") labels.push(`${criteria.customDays}+ dias sem depositar`);
  else if (criteria.timing !== "any" && TIMING_LABEL[criteria.timing])
    labels.push(TIMING_LABEL[criteria.timing]);
  if (criteria.daysWithoutLogin) labels.push(`${criteria.daysWithoutLogin}+ dias sem entrar`);
  if (criteria.daysSinceRegistration)
    labels.push(`${criteria.daysSinceRegistration}+ dias de cadastro`);
  if (labels.length === 0 && !selection) labels.push("Todos com telefone válido");
  return labels;
}
