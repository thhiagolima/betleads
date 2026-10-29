import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WaterfallStep } from "@/lib/finance/types";

import { NO_FEE_NOTE, WaterfallChart, waterfallBars } from "./waterfall-chart";

const steps: WaterfallStep[] = [
  { key: "deposits", label: "Depósitos", kind: "start", start: 0, end: 1000 },
  { key: "withdrawals", label: "Saques", kind: "down", start: 1000, end: 600 },
  { key: "net", label: "Net", kind: "subtotal", start: 600, end: 600 },
  { key: "ggr_fee", label: "Taxa de GGR", kind: "down", start: 600, end: 500 },
  { key: "ad_spend", label: "Anúncios", kind: "down", start: 500, end: -100 },
  { key: "other_costs", label: "Outros custos", kind: "up", start: -100, end: -50 },
  { key: "profit", label: "Lucro líquido", kind: "total", start: -50, end: -50 },
];

describe("waterfallBars", () => {
  it("waterfall chart data keeps the step order", () => {
    expect(waterfallBars(steps).map((bar) => bar.key)).toEqual(steps.map((step) => step.key));
    expect(waterfallBars(steps).map((bar) => bar.label)).toEqual(steps.map((step) => step.label));
  });

  it("puts a transparent base under each step and the step's size on top", () => {
    const bars = waterfallBars(steps);
    const pick = (key: string) => bars.find((bar) => bar.key === key);

    // Start, subtotal and total grow from zero.
    expect(pick("deposits")).toMatchObject({ base: 0, value: 1000, amount: 1000 });
    expect(pick("net")).toMatchObject({ base: 0, value: 600, amount: 600 });
    // A down step floats between its end and start; its amount is negative.
    expect(pick("withdrawals")).toMatchObject({ base: 600, value: 400, amount: -400 });
    expect(pick("ggr_fee")).toMatchObject({ base: 500, value: 100, amount: -100 });
    // Crossing zero: the bar spans from the (negative) end up to the start.
    expect(pick("ad_spend")).toMatchObject({ base: -100, value: 600, amount: -600 });
    expect(pick("other_costs")).toMatchObject({ base: -100, value: 50, amount: 50 });
    // A negative total hangs below zero.
    expect(pick("profit")).toMatchObject({ base: -50, value: 50, amount: -50 });
  });

  it("colors down red, up green, start/subtotal neutral and the total by sign", () => {
    const tones = Object.fromEntries(waterfallBars(steps).map((bar) => [bar.key, bar.tone]));
    expect(tones).toEqual({
      deposits: "neutral",
      withdrawals: "down",
      net: "neutral",
      ggr_fee: "down",
      ad_spend: "down",
      other_costs: "up",
      profit: "negative",
    });

    const positive = waterfallBars([
      { key: "profit", label: "Lucro líquido", kind: "total", start: 10, end: 10 },
    ]);
    expect(positive[0].tone).toBe("positive");
  });
});

describe("WaterfallChart", () => {
  it("renders an empty state with no steps", () => {
    expect(renderToStaticMarkup(<WaterfallChart steps={[]} />)).toContain("Sem dados no período.");
  });

  it("notes the result has no mensalidade outside a closed month", () => {
    expect(NO_FEE_NOTE).toBe("Resultado sem a mensalidade do mês (entra no fechamento do mês).");
    expect(renderToStaticMarkup(<WaterfallChart steps={steps} withoutFee />)).toContain(
      NO_FEE_NOTE,
    );
    expect(renderToStaticMarkup(<WaterfallChart steps={steps} />)).not.toContain(NO_FEE_NOTE);
  });
});
