// Cálculo puro (client-safe) dos limites de período dos painéis da Área do
// Expert (Fase 3, Task 3), no fuso America/Sao_Paulo (tz.ts).
//
// Os presets são os de `PERIODS` (`crm-results/search.ts`, os mesmos do
// `CentralPeriodPicker`) mais os meses de calendário "Este mês" e "Mês
// passado", que só as telas do expert usam (extrato de comissão por mês). A
// lista da Central de Resultados não muda. Esse módulo não importa React nem
// código client-only.

import { brtDayKey, brtDayStart, parseBrtDayStart } from "@/lib/tz";
import { PERIODS } from "@/components/crm-results/search";

export const EXPERT_PERIODS = [
  ...PERIODS.map(({ key, label }) => ({ key, label })),
  { key: "mes_atual", label: "Este mês" },
  { key: "mes_anterior", label: "Mês passado" },
] as const;

export type PeriodKey = (typeof EXPERT_PERIODS)[number]["key"];

export const EXPERT_PERIOD_KEYS = EXPERT_PERIODS.map((p) => p.key) as [PeriodKey, ...PeriodKey[]];

/** Período padrão dos painéis (global-constraints.md): últimos 30 dias. */
export const DEFAULT_EXPERT_PERIOD: PeriodKey = "30";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 em São Paulo do dia 1º do mês (de São Paulo) que contém `at`. */
function brtMonthStart(at: Date): Date {
  const [y, m] = brtDayKey(at).split("-");
  return parseBrtDayStart(`${y}-${m}-01`);
}

/**
 * Limites ISO (half-open, `[from, to)`) do período `key` relativo ao
 * instante `now`, em dias de São Paulo:
 * - "hoje": 00:00 de hoje até `now`;
 * - "ontem": o dia inteiro anterior (00:00 de ontem até 00:00 de hoje);
 * - "7"/"30"/"90": os N últimos dias incluindo hoje (00:00 de N-1 dias atrás
 *   até `now`);
 * - "mes_atual": 00:00 do dia 1º deste mês até `now`;
 * - "mes_anterior": o mês anterior inteiro (00:00 do dia 1º do mês passado
 *   até 00:00 do dia 1º deste mês).
 */
export function periodRange(key: PeriodKey, now: Date): { from: string; to: string } {
  const todayStart = brtDayStart(now);
  switch (key) {
    case "hoje":
      return { from: todayStart.toISOString(), to: now.toISOString() };
    case "ontem": {
      const from = new Date(todayStart.getTime() - DAY_MS);
      return { from: from.toISOString(), to: todayStart.toISOString() };
    }
    case "7":
    case "30":
    case "90": {
      const days = Number(key);
      const from = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
      return { from: from.toISOString(), to: now.toISOString() };
    }
    case "mes_atual":
      return { from: brtMonthStart(now).toISOString(), to: now.toISOString() };
    case "mes_anterior": {
      const thisMonth = brtMonthStart(now);
      // Um instante qualquer do mês anterior: a véspera do dia 1º.
      const lastMonth = brtMonthStart(new Date(thisMonth.getTime() - DAY_MS));
      return { from: lastMonth.toISOString(), to: thisMonth.toISOString() };
    }
    default: {
      const unknown: never = key;
      throw new Error(`periodRange: período desconhecido "${String(unknown)}".`);
    }
  }
}
