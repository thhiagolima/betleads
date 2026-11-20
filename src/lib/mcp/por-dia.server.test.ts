// "Por dia" helper: the days of a period (capped at today, at most 31) and
// the per-day runner (a failing day doesn't sink the others).
import { describe, expect, it } from "vitest";

import { DIAS_CONCURRENCY, MAX_DIAS_POR_DIA, diasDe, diasDoPeriodo, porDia } from "./por-dia.server";

// 2026-11-20 10:00 in Brasília.
const NOW = new Date("2026-11-20T13:00:00.000Z");

describe("diasDoPeriodo", () => {
  it("lists every day, oldest first, across a month boundary", () => {
    expect(diasDoPeriodo("2026-10-30", "2026-11-02", NOW)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("stops at today in Brasília", () => {
    expect(diasDoPeriodo("2026-11-18", "2026-11-25", NOW)).toEqual([
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ]);
  });

  it("accepts 31 days and refuses 32", () => {
    expect(diasDoPeriodo("2026-10-01", "2026-10-31", NOW)).toHaveLength(MAX_DIAS_POR_DIA);
    expect(() => diasDoPeriodo("2026-10-01", "2026-11-01", NOW)).toThrow("No máximo 31 dias");
  });

  it("refuses an inverted period or one that starts after today", () => {
    expect(() => diasDoPeriodo("2026-11-10", "2026-11-01", NOW)).toThrow("Período inválido");
    expect(() => diasDoPeriodo("2026-11-21", "2026-11-22", NOW)).toThrow("depois de hoje");
  });
});

describe("porDia", () => {
  it("keeps the days in order, with at most DIAS_CONCURRENCY in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const dias = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
    const result = await porDia(dias, async (dia) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, dia.endsWith("1") ? 5 : 1));
      inFlight--;
      return { valor: Number(dia.slice(-1)) };
    });
    expect(peak).toBeLessThanOrEqual(DIAS_CONCURRENCY);
    expect(result.dias).toEqual(dias.map((data, i) => ({ data, valor: i + 1 })));
    expect(result.dias_com_erro).toEqual([]);
  });

  it("a failing day goes to dias_com_erro and the others come back", async () => {
    const result = await porDia(["2026-11-01", "2026-11-02"], async (dia) => {
      if (dia === "2026-11-02") throw new Error("A casa demorou demais para responder.");
      return { valor: 1 };
    });
    expect(result.dias).toEqual([{ data: "2026-11-01", valor: 1 }]);
    expect(result.dias_com_erro).toEqual([
      { data: "2026-11-02", erro: "A casa demorou demais para responder." },
    ]);
  });

  it("fails with the first error when every day fails", async () => {
    await expect(
      porDia(["2026-11-01", "2026-11-02"], async () => {
        throw new Error("Sem permissão");
      }),
    ).rejects.toThrow("Sem permissão");
  });
});

describe("diasDe", () => {
  it("expands a preset through the panel's presetRange", () => {
    expect(diasDe({ preset: "7d" }, NOW)).toEqual([
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ]);
  });
});
