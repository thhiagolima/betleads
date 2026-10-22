import { describe, expect, it } from "vitest";

import {
  applyRankingFilters,
  buildGamificationData,
  sanitizeRankingSearch,
  type DbPlayer,
} from "./gamification.functions";

const settings = {
  thresholds: { bronze: 10, silver: 200, gold: 500, diamond: 1000, black: 3000 },
  coolingAfterDays: 2,
  sleepingAfterDays: 7,
  vipMinLevel: "diamond" as const,
};

function fakeQuery() {
  const calls: Array<[string, ...unknown[]]> = [];
  const q = {
    calls,
    or(filters: string) {
      calls.push(["or", filters]);
      return q;
    },
    gte(column: string, value: unknown) {
      calls.push(["gte", column, value]);
      return q;
    },
    lt(column: string, value: unknown) {
      calls.push(["lt", column, value]);
      return q;
    },
  };
  return q;
}

describe("buildGamificationData (C-03)", () => {
  it("conta todos os VIPs esfriando, não só os 50 primeiros", () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const players: DbPlayer[] = Array.from({ length: 73 }, (_, i) => ({
      id: `p${i}`,
      nome: `Jogador ${i}`,
      player_external_id: null,
      total_depositado: 5000 + i,
      total_sacado: 0,
      ultimo_deposito: old,
      ftd_em: old,
      telefone: null,
      email: null,
    }));
    const result = buildGamificationData(players, settings);
    expect(result.totals.stoppedVipCount).toBe(73);
    expect(result.vipStopped).toHaveLength(8);
  });
});

describe("applyRankingFilters (C-07)", () => {
  it("sem filtros não restringe nada", () => {
    const q = fakeQuery();
    applyRankingFilters(q, {}, settings);
    expect(q.calls).toEqual([]);
  });

  it("busca por nome, telefone e ID na base inteira", () => {
    const q = fakeQuery();
    applyRankingFilters(q, { search: " maria " }, settings);
    expect(q.calls).toEqual([
      ["or", "nome.ilike.%maria%,telefone.ilike.%maria%,player_external_id.ilike.%maria%"],
    ]);
  });

  it("remove caracteres que quebram o or() do PostgREST", () => {
    expect(sanitizeRankingSearch("a,b(c)*%\\d")).toBe("a b c    d");
  });

  it("nível vira faixa de total depositado com as faixas configuradas", () => {
    const q = fakeQuery();
    applyRankingFilters(q, { level: "gold" }, settings);
    expect(q.calls).toEqual([
      ["gte", "total_depositado", 500],
      ["lt", "total_depositado", 1000],
    ]);
    const novice = fakeQuery();
    applyRankingFilters(novice, { level: "novice" }, settings);
    expect(novice.calls).toEqual([["lt", "total_depositado", 10]]);
  });

  it("só quem parou: sem depósito ou último depósito antes do corte de esfriando", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const q = fakeQuery();
    applyRankingFilters(q, { onlyStopped: true }, settings, now);
    expect(q.calls).toEqual([
      [
        "or",
        "and(ftd_em.is.null,total_depositado.lte.0),ultimo_deposito.lt.2026-10-19T12:00:00.000Z,and(ultimo_deposito.is.null,or(ftd_em.is.null,ftd_em.lt.2026-10-19T12:00:00.000Z))",
      ],
    ]);
  });
});
