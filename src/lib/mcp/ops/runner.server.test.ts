// MCP do grupo: the helpers every operação tool shares (spec §5 "Formato
// comum", §8): a failing house goes to casas_com_erro, two currencies give
// two totals and never a sum across them, and no output carries player data.
import { describe, expect, it } from "vitest";

import { OPS_CONCURRENCY, OPS_LIST_MAX } from "../config.server";
import {
  CHAVES_PESSOAIS,
  assertSemDadosPessoais,
  escopoOps,
  limiteInput,
  periodoOps,
  porCasa,
  toRange,
  totaisPorMoeda,
  truncar,
} from "./runner.server";
import type { CasaOps } from "./scope.server";

const casa = (id: string, moeda: CasaOps["moeda"] = "BRL"): CasaOps => ({
  id,
  nome: `Casa ${id}`,
  moeda,
  status: "active",
  isDemo: false,
  grupo: null,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("porCasa", () => {
  it("keeps the input order and isolates a failing house", async () => {
    const casas = [casa("a"), casa("b"), casa("c")];
    const result = await porCasa(casas, async (c) => {
      await tick();
      if (c.id === "b") throw new Error("timeout na casa");
      return c.id.toUpperCase();
    });
    expect(result.ok.map((row) => [row.casa.id, row.resultado])).toEqual([
      ["a", "A"],
      ["c", "C"],
    ]);
    expect(result.casas_com_erro).toEqual([{ id: "b", nome: "Casa b", erro: "timeout na casa" }]);
  });

  it(`never runs more than ${OPS_CONCURRENCY} houses at once`, async () => {
    let running = 0;
    let peak = 0;
    const casas = Array.from({ length: 20 }, (_, i) => casa(String(i)));
    await porCasa(casas, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      return null;
    });
    expect(peak).toBe(OPS_CONCURRENCY);
  });

  it("honors a custom concurrency", async () => {
    let running = 0;
    let peak = 0;
    await porCasa(
      Array.from({ length: 5 }, (_, i) => casa(String(i))),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      },
      { concorrencia: 2 },
    );
    expect(peak).toBe(2);
  });

  it("throws only when every house failed", async () => {
    await expect(
      porCasa([casa("a"), casa("b")], async () => {
        throw new Error("fora do ar");
      }),
    ).rejects.toThrow("Nenhuma casa respondeu. fora do ar");
  });

  it("no house, no error", async () => {
    expect(await porCasa([], async () => 1)).toEqual({ ok: [], casas_com_erro: [] });
  });

  it("cuts a long error message", async () => {
    const result = await porCasa([casa("a"), casa("b")], async (c) => {
      if (c.id === "a") throw new Error("x".repeat(1000));
      return 1;
    });
    expect(result.casas_com_erro[0].erro.length).toBeLessThanOrEqual(200);
  });
});

describe("totaisPorMoeda", () => {
  it("two currencies give two totals, never one sum across them", () => {
    const rows = [
      { moeda: "BRL", depositado: 100.1, ftds: 2 },
      { moeda: "ARS", depositado: 5000, ftds: 1 },
      { moeda: "BRL", depositado: 0.2, ftds: 3 },
    ];
    const totals = totaisPorMoeda(rows, (row) => ({
      moeda: row.moeda,
      valores: { depositado: row.depositado, ftds: row.ftds },
    }));
    expect(totals).toEqual([
      { moeda: "ARS", linhas: 1, totais: { depositado: 5000, ftds: 1 } },
      { moeda: "BRL", linhas: 2, totais: { depositado: 100.3, ftds: 5 } },
    ]);
  });

  it("skips nulls; a field null on every row totals null", () => {
    const totals = totaisPorMoeda(
      [
        { a: null, b: 1 },
        { a: undefined, b: null },
      ],
      (row) => ({ moeda: "BRL", valores: row }),
    );
    expect(totals).toEqual([{ moeda: "BRL", linhas: 2, totais: { a: null, b: 1 } }]);
  });
});

describe("toRange / periodoOps", () => {
  const now = new Date("2026-11-17T15:00:00Z"); // 12:00 in Brasília

  it("a preset is the finance panel's window, with Brasília day bounds", () => {
    expect(toRange({ preset: "7d" }, now)).toEqual({
      inicio: "2026-11-11",
      fim: "2026-11-17",
      preset: "7d",
      fromInstant: "2026-11-11T03:00:00.000Z",
      toInstant: "2026-11-18T03:00:00.000Z",
    });
    expect(toRange({ preset: "today" }, now)).toMatchObject({
      inicio: "2026-11-17",
      fim: "2026-11-17",
    });
  });

  it("a custom range uses inicio and fim inclusive", () => {
    expect(toRange({ inicio: "2026-10-01", fim: "2026-10-31" }, now)).toMatchObject({
      preset: "custom",
      fromInstant: "2026-10-01T03:00:00.000Z",
      toInstant: "2026-11-01T03:00:00.000Z",
    });
  });

  it("refuses a missing or inverted range", () => {
    expect(() => toRange({}, now)).toThrow("Informe o período");
    expect(() => toRange({ inicio: "2026-10-31", fim: "2026-10-01" }, now)).toThrow(
      "Período inválido",
    );
  });

  it("periodoOps validates dates", () => {
    expect(periodoOps.safeParse({ inicio: "2026-02-30", fim: "2026-03-01" }).success).toBe(false);
    expect(periodoOps.safeParse({ preset: "month" }).success).toBe(true);
  });
});

describe("escopoOps", () => {
  it("accepts casa/grupo with a uuid and todas", () => {
    expect(escopoOps.safeParse({ tipo: "todas" }).success).toBe(true);
    expect(
      escopoOps.safeParse({ tipo: "grupo", id: "00000000-0000-4000-8000-00000000a001" }).success,
    ).toBe(true);
    expect(escopoOps.safeParse({ tipo: "casa", id: "nope" }).success).toBe(false);
    expect(escopoOps.safeParse({ tipo: "rede" }).success).toBe(false);
  });
});

describe("limite / truncar", () => {
  it("limiteInput defaults to 20 and caps at 100", () => {
    expect(limiteInput.parse(undefined)).toBe(20);
    expect(limiteInput.parse(OPS_LIST_MAX)).toBe(OPS_LIST_MAX);
    expect(limiteInput.safeParse(OPS_LIST_MAX + 1).success).toBe(false);
    expect(limiteInput.safeParse(0).success).toBe(false);
  });

  it("truncar keeps the first items and says whether it cut", () => {
    const list = Array.from({ length: 25 }, (_, i) => i);
    expect(truncar(list)).toEqual({ itens: list.slice(0, 20), truncado: true });
    expect(truncar(list, 30)).toEqual({ itens: list, truncado: false });
    expect(truncar(list, 25).truncado).toBe(false);
    expect(truncar(list, 1000).itens).toHaveLength(25);
  });
});

describe("assertSemDadosPessoais", () => {
  it("passes aggregates with expert, campaign and affiliate ids", () => {
    expect(() =>
      assertSemDadosPessoais({
        casas: [{ id: "c", expert_id: "e", affiliate_id: "4512", campanhas: [{ id: "x" }] }],
        totais_por_moeda: [{ moeda: "BRL", totais: { depositado: 1 } }],
      }),
    ).not.toThrow();
  });

  for (const key of CHAVES_PESSOAIS) {
    it(`throws on a nested "${key}" key`, () => {
      expect(() => assertSemDadosPessoais({ casas: [{ itens: [{ [key]: "x" }] }] })).toThrow(
        /dado pessoal/,
      );
    });
  }

  it("is case-insensitive on keys", () => {
    expect(() => assertSemDadosPessoais({ Email: "x" })).toThrow(/dado pessoal/);
  });
});
