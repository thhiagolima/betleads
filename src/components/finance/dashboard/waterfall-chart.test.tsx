import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WaterfallStep } from "@/lib/finance/types";

import { NO_FEE_NOTE, WaterfallChart, waterfallBars, waterfallZeroPct } from "./waterfall-chart";

const steps: WaterfallStep[] = [
  { key: "deposits", label: "Depósitos", kind: "start", start: 0, end: 1000 },
  { key: "withdrawals", label: "Saques", kind: "down", start: 1000, end: 600 },
  { key: "net", label: "Net", kind: "subtotal", start: 600, end: 600 },
  { key: "movement_fee", label: "Taxa de movimentação", kind: "down", start: 600, end: 500 },
  { key: "ad_spend", label: "Anúncios", kind: "down", start: 500, end: -100 },
  { key: "other_costs", label: "Outros custos", kind: "up", start: -100, end: -50 },
  { key: "profit", label: "Lucro líquido", kind: "total", start: -50, end: -50 },
];

describe("waterfallBars", () => {
  it("keeps the step order and shortens long labels to one line", () => {
    const bars = waterfallBars(steps);
    expect(bars.map((bar) => bar.key)).toEqual(steps.map((step) => step.key));
    expect(bars.map((bar) => bar.label)).toEqual([
      "Depósitos",
      "Saques",
      "Net",
      "Taxa de mov.",
      "Anúncios",
      "Outros custos",
      "Lucro líquido",
    ]);
  });

  it("floats each column from its start to its end on a 0–100% vertical scale", () => {
    // Domain −100 … 1000 (1100 wide): zero sits at 100/1100 of the height.
    const bars = waterfallBars(steps);
    const pick = (key: string) => bars.find((bar) => bar.key === key)!;
    const pct = (value: number) => ((value + 100) / 1100) * 100;

    expect(waterfallZeroPct(steps)).toBeCloseTo(pct(0));

    // Start, subtotal and total grow from zero.
    expect(pick("deposits").bottomPct).toBeCloseTo(pct(0));
    expect(pick("deposits").heightPct).toBeCloseTo((1000 / 1100) * 100);
    expect(pick("deposits").amount).toBe(1000);
    expect(pick("net").bottomPct).toBeCloseTo(pct(0));
    expect(pick("net").heightPct).toBeCloseTo((600 / 1100) * 100);

    // A down step floats between its end and its start.
    expect(pick("withdrawals").bottomPct).toBeCloseTo(pct(600));
    expect(pick("withdrawals").heightPct).toBeCloseTo((400 / 1100) * 100);
    expect(pick("withdrawals").amount).toBe(-400);

    // Crossing zero: from the negative end up to the start; label still above.
    expect(pick("ad_spend").bottomPct).toBeCloseTo(pct(-100));
    expect(pick("ad_spend").heightPct).toBeCloseTo((600 / 1100) * 100);
    expect(pick("ad_spend").labelBelow).toBe(false);

    // A negative total hangs below zero and its label goes under it.
    expect(pick("profit").bottomPct).toBeCloseTo(pct(-50));
    expect(pick("profit").heightPct).toBeCloseTo((50 / 1100) * 100);
    expect(pick("profit").labelBelow).toBe(true);
    expect(pick("deposits").labelBelow).toBe(false);
  });

  it("puts zero at the bottom when nothing goes below it", () => {
    const positive: WaterfallStep[] = [
      { key: "deposits", label: "Depósitos", kind: "start", start: 0, end: 200 },
      { key: "profit", label: "Lucro líquido", kind: "total", start: 50, end: 50 },
    ];
    expect(waterfallZeroPct(positive)).toBe(0);
    expect(waterfallBars(positive)[1]).toMatchObject({ bottomPct: 0, heightPct: 25 });
  });

  it("colors entradas blue-gray, saídas red, subtotal slate and the total by sign", () => {
    const tones = Object.fromEntries(waterfallBars(steps).map((bar) => [bar.key, bar.tone]));
    expect(tones).toEqual({
      deposits: "in",
      withdrawals: "down",
      net: "subtotal",
      movement_fee: "down",
      ad_spend: "down",
      other_costs: "in",
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

  it("renders the columns, the legend and the note about hidden steps", () => {
    const html = renderToStaticMarkup(<WaterfallChart steps={steps} />);
    expect(html).toContain("Taxa de mov.");
    expect(html).not.toContain("Taxa de movimentação<");
    expect(html).toContain("Entradas");
    expect(html).toContain("Saídas e custos");
    expect(html).toContain("Subtotal");
    expect(html).toContain("Passos sem valor no período não aparecem.");
    expect(html).toContain("border-dashed");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("-R$ 400");
  });

  it("notes the result has no mensalidade outside a closed month", () => {
    expect(NO_FEE_NOTE).toBe("Resultado sem a mensalidade do mês (entra no fechamento do mês).");
    expect(renderToStaticMarkup(<WaterfallChart steps={steps} withoutFee />)).toContain(
      NO_FEE_NOTE,
    );
    expect(renderToStaticMarkup(<WaterfallChart steps={steps} />)).not.toContain(NO_FEE_NOTE);
  });
});
