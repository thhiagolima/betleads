// MCP do grupo, área de operação: helpers every operação tool shares (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5 "Formato comum").
//
// - `escopoOps` / `periodoOps` / `limiteInput`: the common inputs. escopo and
//   periodo are the finance tools' own shapes (./inputs.server), so a preset
//   is the same window in both areas (days in Brasília time).
// - `toRange`: the periodo as dates plus the half-open instant window
//   [fromInstant, toInstant) the RPCs take (same convention as expert_metrics).
// - `porCasa`: runs a per-house query with at most 6 houses in flight. A house
//   that fails goes to `casas_com_erro` and the rest go on; only when every
//   house fails does the tool fail.
// - `totaisPorMoeda`: one total per currency, never a sum across currencies.
// - `truncar`: lists capped at `limite`, with `truncado`.
// - `assertSemDadosPessoais`: shape check that no output carries player
//   contact/identity keys (anti-goal of the spec). The server runs it on every
//   operação result, and tool tests should run it on their fixtures too.
import { z } from "zod";

import { OPS_CONCURRENCY, OPS_LIST_DEFAULT, OPS_LIST_MAX } from "../config.server";
import { escopoInput, periodoInput, toRangeAndPreset, type Periodo } from "../inputs.server";
import type { CasaOps } from "./scope.server";

// ─── Inputs ─────────────────────────────────────────────────────────────────

export const escopoOps = escopoInput.describe(
  "{tipo: casa, id} | {tipo: grupo, id} | {tipo: todas} (todas as casas que você vê, sem as demo). Ids vêm de listar_escopos.",
);

export const periodoOps = periodoInput.describe(
  "{preset: today|yesterday|7d|month} ou {inicio, fim} (AAAA-MM-DD), dias no horário de Brasília.",
);

export const limiteInput = z
  .number()
  .int()
  .min(1)
  .max(OPS_LIST_MAX)
  .default(OPS_LIST_DEFAULT)
  .describe(`Máximo de itens na lista (padrão ${OPS_LIST_DEFAULT}, máximo ${OPS_LIST_MAX}).`);

// ─── Period ─────────────────────────────────────────────────────────────────

export type PeriodoOps = {
  /** First day (AAAA-MM-DD, Brasília). */
  inicio: string;
  /** Last day, inclusive (AAAA-MM-DD, Brasília). */
  fim: string;
  preset: "today" | "yesterday" | "7d" | "month" | "custom";
  /** Start of `inicio` in Brasília, as an ISO instant. */
  fromInstant: string;
  /** Start of the day after `fim` in Brasília (exclusive bound), as an ISO instant. */
  toInstant: string;
};

const DAY_MS = 86_400_000;
/** Brasília has had no DST since 2019: a day starts at 03:00 UTC. */
const startOfDayBrt = (date: string) => new Date(`${date}T00:00:00-03:00`);

/** The periodo as dates and as the half-open instant window the RPCs take. */
export function toRange(periodo: Periodo, now: Date = new Date()): PeriodoOps {
  const { range, preset } = toRangeAndPreset(periodo, now);
  if (range.from > range.to) throw new Error("Período inválido: o início é depois do fim.");
  return {
    inicio: range.from,
    fim: range.to,
    preset,
    fromInstant: startOfDayBrt(range.from).toISOString(),
    toInstant: new Date(startOfDayBrt(range.to).getTime() + DAY_MS).toISOString(),
  };
}

// ─── Per-house execution ────────────────────────────────────────────────────

export type CasaComErro = { id: string; nome: string; erro: string };
export type PorCasaResult<T> = {
  /** Houses that answered, in the input order. */
  ok: Array<{ casa: CasaOps; resultado: T }>;
  casas_com_erro: CasaComErro[];
};

const ERRO_MAX = 200;
const shortError = (error: unknown) =>
  (error instanceof Error && error.message ? error.message : "Erro ao consultar a casa.").slice(
    0,
    ERRO_MAX,
  );

/**
 * Runs `fn` for every house, at most `concorrencia` (default 6) at a time.
 * A failing house lands in `casas_com_erro` with a short message; throws only
 * when there was at least one house and every one of them failed.
 */
export async function porCasa<T>(
  casas: CasaOps[],
  fn: (casa: CasaOps) => Promise<T>,
  opts: { concorrencia?: number } = {},
): Promise<PorCasaResult<T>> {
  const limit = Math.max(1, opts.concorrencia ?? OPS_CONCURRENCY);
  const settled: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(
    casas.length,
  );
  let next = 0;
  const worker = async () => {
    while (next < casas.length) {
      const index = next++;
      try {
        settled[index] = { ok: true, value: await fn(casas[index]) };
      } catch (error) {
        settled[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, casas.length) }, worker));

  const result: PorCasaResult<T> = { ok: [], casas_com_erro: [] };
  settled.forEach((entry, index) => {
    const casa = casas[index];
    if (entry.ok) result.ok.push({ casa, resultado: entry.value });
    else {
      if (!(entry.error instanceof Error) || !entry.error.message) {
        console.error("[mcp-ops]", casa.id, entry.error);
      }
      result.casas_com_erro.push({ id: casa.id, nome: casa.nome, erro: shortError(entry.error) });
    }
  });
  if (casas.length > 0 && result.ok.length === 0) {
    throw new Error(`Nenhuma casa respondeu. ${result.casas_com_erro[0].erro}`);
  }
  return result;
}

// ─── Totals per currency ────────────────────────────────────────────────────

export type TotalPorMoeda = {
  moeda: string;
  /** Rows summed into this currency's total. */
  linhas: number;
  /** Sum of each field over the rows of this currency (null when every row had null). */
  totais: Record<string, number | null>;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Sums the numeric fields `pick` returns, one total per currency — never
 * across currencies. `null`/`undefined` values are skipped (a field that is
 * null on every row of a currency totals null). Ratios must not be passed
 * here: sum the parts and divide afterwards. Currencies come out sorted.
 */
export function totaisPorMoeda<R>(
  rows: R[],
  pick: (row: R) => { moeda: string; valores: Record<string, number | null | undefined> },
): TotalPorMoeda[] {
  const byCurrency = new Map<string, TotalPorMoeda>();
  for (const row of rows) {
    const { moeda, valores } = pick(row);
    let total = byCurrency.get(moeda);
    if (!total) {
      total = { moeda, linhas: 0, totais: {} };
      byCurrency.set(moeda, total);
    }
    total.linhas += 1;
    for (const [key, value] of Object.entries(valores)) {
      const current = total.totais[key] ?? null;
      if (typeof value === "number" && Number.isFinite(value)) {
        total.totais[key] = round2((current ?? 0) + value);
      } else if (!(key in total.totais)) {
        total.totais[key] = null;
      }
    }
  }
  return Array.from(byCurrency.values()).sort((a, b) => a.moeda.localeCompare(b.moeda));
}

// ─── Lists ──────────────────────────────────────────────────────────────────

/** The first `limite` items and whether anything was cut. */
export function truncar<T>(
  list: T[],
  limite: number = OPS_LIST_DEFAULT,
): { itens: T[]; truncado: boolean } {
  const cap = Math.min(Math.max(1, Math.floor(limite)), OPS_LIST_MAX);
  return { itens: list.slice(0, cap), truncado: list.length > cap };
}

// ─── No personal data ───────────────────────────────────────────────────────

/** Keys that would mean player data is leaving the MCP (spec §3 anti-goals). */
export const CHAVES_PESSOAIS = [
  "telefone",
  "phone",
  "email",
  "cpf",
  "player_id",
  "nome_jogador",
] as const;
const FORBIDDEN = new Set<string>(CHAVES_PESSOAIS);

/** Throws when any key, at any depth, is a player-data key. */
export function assertSemDadosPessoais(value: unknown, path = "resultado"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSemDadosPessoais(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase())) {
      throw new Error(`Saída com dado pessoal bloqueada (${path}.${key}).`);
    }
    assertSemDadosPessoais(child, `${path}.${key}`);
  }
}
