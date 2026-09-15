// Ordem de prioridade dos 17 gatilhos (1 = mais alto). Um lead nunca entra
// em fluxo de prioridade menor se já está em fluxo de prioridade maior.
import type { TriggerType } from "./triggers";

export const PRIORITY_ORDER: TriggerType[] = [
  "lead_cadastrado",
  "recuperacao_vip",
  "vip_esfriando",
  "alto_potencial",
  "quase_vip",
  "dinheiro_parado",
  "receita_em_queda",
  "lead_quente_esfriando",
  "frequencia_caindo",
  "reativacao_em_curso",
  "sem_login_7_14",
  "sem_login_15_24",
  "sem_login_25_34",
  "sem_login_35_44",
  "sem_login_45_59",
  "sem_login_60_mais",
  "engajado_sem_converter",
  "cadastrados_sem_deposito",
];

export function priorityRank(t: TriggerType): number {
  const i = PRIORITY_ORDER.indexOf(t);
  return i < 0 ? 999 : i;
}

export function pickHighestPriority(triggers: TriggerType[]): TriggerType | null {
  if (!triggers.length) return null;
  return [...triggers].sort((a, b) => priorityRank(a) - priorityRank(b))[0];
}