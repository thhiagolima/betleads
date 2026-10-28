import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CostLine } from "@/lib/finance/types";

import { CostBreakdown } from "./cost-breakdown";

// costBreakdown() (calc.ts) marks every computed line auto: true (Anúncios and
// the fees too); the badge is the spec's "automático" tag on Betleads only.
const costs: CostLine[] = [
  { key: "ad_spend", label: "Anúncios", amount: 44100, previous: 31300, auto: true },
  { key: "ggr_fee", label: "Taxa de GGR (16%)", amount: 22050, previous: 20100, auto: true },
  { key: "betleads", label: "Betleads", amount: 5200, previous: 5000, auto: true },
  { key: "category:Equipe", label: "Equipe", amount: 1200, previous: null, auto: false },
];

describe("CostBreakdown", () => {
  it("renders rows in given order with the automático badge only on Betleads", () => {
    const html = renderToStaticMarkup(<CostBreakdown costs={costs} />);

    const positions = costs.map((line) => html.indexOf(`data-cost="${line.key}"`));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(html.match(/automático/g)).toHaveLength(1);
    expect(html.slice(positions[2], positions[3])).toContain("automático");

    expect(html).toContain("R$ 44.100,00");
    expect(html).toContain("Taxa de GGR (16%)");
  });

  it("sizes the bar against the largest line and shows the variation", () => {
    const html = renderToStaticMarkup(<CostBreakdown costs={costs} />);

    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
    expect(html).toContain("▲ 40,9%"); // 44100 vs 31300
    expect(html).toContain("text-rose-400"); // a cost going up is bad
    expect(html).toContain("n.a."); // Equipe has no previous
  });

  it("renders an empty state when there are no costs", () => {
    const html = renderToStaticMarkup(<CostBreakdown costs={[]} />);

    expect(html).toContain("Sem custos no período.");
  });
});
