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

/** Período padrão das telas de relatório (global-constraints.md): este mês. */
export const DEFAULT_REPORT_PERIOD: PeriodKey = "mes_atual";

type IsoRange = { from: string; to: string };

/**
 * Limites do período anterior, de mesma duração que `current` e terminando
 * no mesmo ponto relativo (spec `2026-10-28-relatorio-rendimento-design.md`
 * §4, bloco 1):
 * - "hoje"/"ontem"/"7"/"30"/"90": desloca `current` em N dias (N = 1 para
 *   hoje e ontem, N = o tamanho do período para 7/30/90). Sem DST no
 *   Brasil, deslocar em dias corridos preserva o horário do dia.
 * - "mes_atual": do dia 1º do mês anterior até o mesmo dia e hora de
 *   `now`; se o mês anterior for mais curto, o limite vai até o fim dele
 *   (ou seja, até o início deste mês).
 * - "mes_anterior": o mês inteiro anterior ao mês anterior.
 */
function previousRange(key: PeriodKey, now: Date, current: IsoRange): IsoRange {
  switch (key) {
    case "hoje":
    case "ontem":
    case "7":
    case "30":
    case "90": {
      const days = key === "hoje" || key === "ontem" ? 1 : Number(key);
      const shift = days * DAY_MS;
      return {
        from: new Date(new Date(current.from).getTime() - shift).toISOString(),
        to: new Date(new Date(current.to).getTime() - shift).toISOString(),
      };
    }
    case "mes_atual": {
      const thisMonthStart = brtMonthStart(now);
      const todayStart = brtDayStart(now);
      const prevMonthStart = brtMonthStart(new Date(thisMonthStart.getTime() - DAY_MS));
      const dayOfMonth = Math.round((todayStart.getTime() - thisMonthStart.getTime()) / DAY_MS) + 1;
      const daysInPrevMonth = Math.round((thisMonthStart.getTime() - prevMonthStart.getTime()) / DAY_MS);
      const elapsedMs = now.getTime() - todayStart.getTime();
      const to =
        dayOfMonth <= daysInPrevMonth
          ? new Date(prevMonthStart.getTime() + (dayOfMonth - 1) * DAY_MS + elapsedMs)
          : thisMonthStart;
      return { from: prevMonthStart.toISOString(), to: to.toISOString() };
    }
    case "mes_anterior": {
      const lastMonthStart = parseBrtDayStart(current.from.slice(0, 10));
      const monthBeforeLastStart = brtMonthStart(new Date(lastMonthStart.getTime() - DAY_MS));
      return { from: monthBeforeLastStart.toISOString(), to: lastMonthStart.toISOString() };
    }
    default: {
      const unknown: never = key;
      throw new Error(`previousRange: período desconhecido "${String(unknown)}".`);
    }
  }
}

/**
 * Pares `de`/`até` do período atual e do período anterior de mesma
 * duração, para comparação (spec §4, bloco 1). `current` é igual a
 * `periodRange(key, now)`.
 */
export function comparisonRange(
  key: PeriodKey,
  now: Date,
): { current: IsoRange; previous: IsoRange } {
  const current = periodRange(key, now);
  return { current, previous: previousRange(key, now, current) };
}

/**
 * Variação percentual de `current` em relação a `previous`, arredondada a
 * 1 casa decimal. Devolve `null` quando não há base (`previous === 0`).
 */
export function variationPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
