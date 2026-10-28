// Cálculo puro (client-safe) dos limites de período dos painéis da Área do
// Expert (Fase 3, Task 3), no fuso America/Sao_Paulo (tz.ts).
//
// Reexporta `PERIODS`/`PeriodKey` de `crm-results/search.ts` — mesmos presets
// do `CentralPeriodPicker` (global-constraints.md). Esse módulo não importa
// React nem código client-only, então os painéis do expert usam os mesmos
// valores sem duplicar a lista nem precisar de nenhuma extração adicional.

import { brtDayStart } from "@/lib/tz";
import { PERIODS, type PeriodKey } from "@/components/crm-results/search";

export { PERIODS, type PeriodKey };

/** Período padrão dos painéis (global-constraints.md): últimos 30 dias. */
export const DEFAULT_EXPERT_PERIOD: PeriodKey = "30";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Limites ISO (half-open, `[from, to)`) do período `key` relativo ao
 * instante `now`, em dias de São Paulo:
 * - "hoje": 00:00 de hoje até `now`;
 * - "ontem": o dia inteiro anterior (00:00 de ontem até 00:00 de hoje);
 * - "7"/"30"/"90": os N últimos dias incluindo hoje (00:00 de N-1 dias atrás
 *   até `now`).
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
    default: {
      const unknown: never = key;
      throw new Error(`periodRange: período desconhecido "${String(unknown)}".`);
    }
  }
}
