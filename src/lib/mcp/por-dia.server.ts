// "Por dia" tools (resumo_por_dia, visao_geral_por_dia): one MCP call returns
// a period broken down by day, by running the same per-period function the
// panel uses once per day (preset "custom", início = fim = that day). The
// numbers are exactly what a one-day query would give, without Claude making
// one call per day (which used to hit the 60/min rate limit).
import { presetRange } from "@/lib/finance/calc";

import { periodoInput, toRangeAndPreset, type Periodo } from "./inputs.server";

/** Most days one "por dia" call may cover. */
export const MAX_DIAS_POR_DIA = 31;
/** Days computed at the same time by one "por dia" call. */
export const DIAS_CONCURRENCY = 3;

export const periodoPorDiaInput = periodoInput.describe(
  `{preset: today|yesterday|7d|month} ou {inicio, fim} (AAAA-MM-DD), dias no horário de Brasília; no máximo ${MAX_DIAS_POR_DIA} dias por chamada, e dias depois de hoje ficam de fora.`,
);

const DAY_MS = 86_400_000;

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Every day from inicio to fim (capped at today in Brasília), oldest first. */
export function diasDoPeriodo(inicio: string, fim: string, now: Date = new Date()): string[] {
  if (inicio > fim) throw new Error("Período inválido: o início é depois do fim.");
  const hoje = presetRange("today", now).from;
  if (inicio > hoje) throw new Error("O período começa depois de hoje.");
  const ultimo = fim > hoje ? hoje : fim;
  const dias: string[] = [];
  for (let dia = inicio; dia <= ultimo; dia = addDays(dia, 1)) {
    dias.push(dia);
    if (dias.length > MAX_DIAS_POR_DIA) {
      throw new Error(
        `No máximo ${MAX_DIAS_POR_DIA} dias por chamada. Divida o período (ex.: um mês por vez).`,
      );
    }
  }
  return dias;
}

/** The days of a periodo (preset or início/fim), as diasDoPeriodo. */
export function diasDe(periodo: Periodo, now: Date = new Date()): string[] {
  const { range } = toRangeAndPreset(periodo, now);
  return diasDoPeriodo(range.from, range.to, now);
}

export type DiaComErro = { data: string; erro: string };

/**
 * Runs `fn` for each day with at most DIAS_CONCURRENCY in flight. A failing
 * day goes to `dias_com_erro` and the rest go on; only when every day fails
 * does the call fail (with the first day's message).
 */
export async function porDia<T>(
  dias: string[],
  fn: (dia: string) => Promise<T>,
): Promise<{ dias: Array<{ data: string } & T>; dias_com_erro: DiaComErro[] }> {
  const resultados: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(
    dias.length,
  );
  let next = 0;
  async function worker() {
    while (next < dias.length) {
      const index = next++;
      try {
        resultados[index] = { ok: true, value: await fn(dias[index]) };
      } catch (error) {
        resultados[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DIAS_CONCURRENCY, dias.length) }, () => worker()),
  );

  const ok: Array<{ data: string } & T> = [];
  const falhas: DiaComErro[] = [];
  resultados.forEach((entry, index) => {
    if (entry.ok) ok.push({ data: dias[index], ...entry.value });
    else falhas.push({ data: dias[index], erro: mensagem(entry.error) });
  });
  if (ok.length === 0 && falhas.length > 0) {
    const first = resultados.find((entry) => !entry.ok);
    throw first && !first.ok && first.error instanceof Error
      ? first.error
      : new Error(falhas[0].erro);
  }
  return { dias: ok, dias_com_erro: falhas };
}

function mensagem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
