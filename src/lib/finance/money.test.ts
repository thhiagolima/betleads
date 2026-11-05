import { describe, expect, it } from "vitest";

import { computeDay, summarize } from "./calc";
import { computeKpis, waterfallSteps } from "./kpis";
import {
  distinctCurrencies,
  groupByCurrency,
  mixedCurrencyNote,
  profitComputable,
  singleCurrency,
  totalsByCurrency,
} from "./money";
import type { DayActivity, FinanceDayInput } from "./types";

const day = (overrides: Partial<FinanceDayInput> = {}): FinanceDayInput => ({
  date: "2026-10-20",
  registrations: 10,
  ftds: 2,
  ftdDepositAmount: 0,
  depositAmount: 10_000,
  withdrawalAmount: 4_000,
  adSpend: 1_000,
  adSpendSuggested: null,
  ggr: 0,
  ggrFeePct: 0,
  movementFeePct: 0,
  ...overrides,
});

const noActivity: DayActivity = {
  depositCount: 0,
  depositorCount: 0,
  withdrawalCount: 0,
  generatedPixCount: 0,
  crmSent: 0,
  crmClicks: 0,
  crmDirectConversions: 0,
  crmDirectRevenue: 500,
  crmInfluencedRevenue: 900,
  adImpressions: 0,
  adClicks: 0,
};

describe("moedas de um conjunto de casas", () => {
  it("singleCurrency: a moeda única, null quando há mais de uma, BRL sem casas", () => {
    expect(singleCurrency(["ARS", "ARS"])).toBe("ARS");
    expect(singleCurrency(["BRL", "ARS"])).toBeNull();
    expect(singleCurrency([])).toBe("BRL");
    // Casa sem a coluna (ou valor desconhecido) conta como BRL.
    expect(singleCurrency([null, "BRL", "xyz"])).toBe("BRL");
  });

  it("distinctCurrencies põe BRL primeiro e o resto em ordem alfabética", () => {
    expect(distinctCurrencies(["MXN", "ARS", "BRL", "ARS"])).toEqual(["BRL", "ARS", "MXN"]);
  });

  it("groupByCurrency mantém a ordem das casas dentro de cada moeda", () => {
    const houses = [
      { nome: "C", moeda: "ARS" },
      { nome: "A", moeda: "BRL" },
      { nome: "B", moeda: "ARS" },
    ];
    expect(
      groupByCurrency(houses, (h) => h.moeda).map((g) => [g.currency, g.items.map((h) => h.nome)]),
    ).toEqual([
      ["BRL", ["A"]],
      ["ARS", ["C", "B"]],
    ]);
  });

  it("totalsByCurrency soma só casas da mesma moeda, nunca entre moedas", () => {
    const houses = [
      { moeda: "BRL", valor: 1000 },
      { moeda: "ARS", valor: 50_000 },
      { moeda: "BRL", valor: 0.1 },
      { moeda: "ARS", valor: 0.2 },
    ];
    expect(
      totalsByCurrency(
        houses,
        (h) => h.moeda,
        (h) => h.valor,
      ),
    ).toEqual([
      { currency: "BRL", amount: 1000.1 },
      { currency: "ARS", amount: 50_000.2 },
    ]);
  });

  it("um valor null deixa o total daquela moeda null (lucro de casa fora do BRL)", () => {
    const houses = [
      { moeda: "BRL", lucro: 300 },
      { moeda: "ARS", lucro: null },
      { moeda: "ARS", lucro: null },
    ];
    expect(
      totalsByCurrency(
        houses,
        (h) => h.moeda,
        (h) => h.lucro,
      ),
    ).toEqual([
      { currency: "BRL", amount: 300 },
      { currency: "ARS", amount: null },
    ]);
  });

  it("profitComputable e a nota de câmbio", () => {
    expect(profitComputable("BRL")).toBe(true);
    expect(profitComputable(undefined)).toBe(true);
    expect(profitComputable("ARS")).toBe(false);
    expect(mixedCurrencyNote("ARS")).toBe(
      "Receita em ARS e custos em BRL: sem conversão de câmbio",
    );
  });
});

describe("lucro com moedas misturadas", () => {
  it("summarize fora do BRL: sem Lucro líquido, ROI nem média; o resto na moeda da casa", () => {
    const summary = summarize(
      [computeDay(day())],
      200,
      undefined,
      { usage: 50, fee: 4000 },
      {
        currency: "ARS",
      },
    );
    expect(summary.cashResult).toBeNull();
    expect(summary.roi).toBeNull();
    expect(summary.avgDailyCashResult).toBeNull();
    expect(summary.net).toBe(6000);
    expect(summary.adSpend).toBe(1000);
    expect(summary.otherCosts).toBe(200);
    expect(summary.betleadsUsage).toBe(50);
    expect(summary.costPerRegistration).toBe(100);
  });

  it("summarize em BRL (explícito) é igual ao padrão", () => {
    const days = [computeDay(day())];
    const betleads = { usage: 50, fee: 4000 };
    expect(summarize(days, 200, undefined, betleads, { currency: "BRL" })).toEqual(
      summarize(days, 200, undefined, betleads),
    );
    expect(summarize(days, 200, undefined, betleads).cashResult).toBe(750);
  });

  it("waterfall fora do BRL para antes dos custos Betleads, na moeda da casa", () => {
    const summary = summarize(
      [computeDay(day())],
      200,
      undefined,
      { usage: 50, fee: 4000 },
      {
        currency: "ARS",
      },
    );
    const steps = waterfallSteps(summary, 50, { Designer: 200 }, { currency: "ARS" });
    expect(steps.map((s) => s.key)).toEqual([
      "deposits",
      "withdrawals",
      "net",
      "ad_spend",
      "category:Designer",
      "house_result",
    ]);
    expect(steps.at(-1)).toMatchObject({ kind: "subtotal", end: 4800 });
    expect(steps.some((s) => s.key === "sends" || s.key === "fee" || s.key === "profit")).toBe(
      false,
    );
  });

  it("computeKpis fora do BRL: sem margem nem retorno do CRM (receita ÷ envios em BRL)", () => {
    const summary = summarize(
      [computeDay(day())],
      0,
      undefined,
      { usage: 50, fee: null },
      {
        currency: "ARS",
      },
    );
    const sends = [{ item: "sms" as const, units: 10, amount: 50, missingCostUnits: 0 }];
    const kpis = computeKpis(summary, noActivity, sends, 1, 0, "ARS");
    expect(kpis.margin).toBeNull();
    expect(kpis.crmDirectReturn).toBeNull();
    expect(kpis.crmInfluencedReturn).toBeNull();
    expect(kpis.sendCost).toBe(50);
    expect(kpis.crmDirectRevenue).toBe(500);

    const brl = computeKpis(
      summarize([computeDay(day())], 0, undefined, { usage: 50, fee: null }),
      noActivity,
      sends,
      1,
      0,
    );
    expect(brl.crmDirectReturn).toBe(10);
  });
});
