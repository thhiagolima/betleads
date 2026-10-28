import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GGR_ESTIMATED_NOTE, KpiCards, NO_OTHER_COSTS_NOTE } from "./kpi-cards";
import { summary } from "./test-fixtures";

// No jsdom/testing-library in this repo: assert on the static markup. Each
// card carries data-kpi="<key>"; card() cuts the markup from that card to the
// next one so a test looks at one card only.
function card(html: string, key: string) {
  const start = html.indexOf(`data-kpi="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-kpi=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("KpiCards", () => {
  it("notes the result has no other costs when the window is not a closed month", () => {
    const open = renderToStaticMarkup(
      <KpiCards current={summary({ otherCosts: null })} previous={summary()} />,
    );
    expect(open).toContain(
      "Resultado sem outros custos e mensalidade do mês (só entram em mês fechado).",
    );
    expect(NO_OTHER_COSTS_NOTE).toBe(
      "Resultado sem outros custos e mensalidade do mês (só entram em mês fechado).",
    );

    const closed = renderToStaticMarkup(
      <KpiCards current={summary({ otherCosts: 0 })} previous={summary()} />,
    );
    expect(closed).not.toContain("só entram em mês fechado");
  });

  it("shows ▲ green when profit rises and red ▲ when ad spend rises", () => {
    const html = renderToStaticMarkup(
      <KpiCards
        current={summary({ cashResult: 1150, adSpend: 1200 })}
        previous={summary({ cashResult: 1000, adSpend: 1000 })}
      />,
    );

    const profit = card(html, "cashResult");
    expect(profit).toContain("Lucro líquido");
    expect(profit).toContain("▲ 15,0%");
    expect(profit).toContain("text-emerald-400");

    const ads = card(html, "adSpend");
    expect(ads).toContain("Investido em anúncios");
    expect(ads).toContain("▲ 20,0%");
    expect(ads).toContain("text-rose-400");
  });

  it("shows n.a. for null ROI", () => {
    const html = renderToStaticMarkup(
      <KpiCards current={summary({ roi: null })} previous={summary({ roi: 0.5 })} />,
    );

    const roi = card(html, "roi");
    expect(roi).toContain("Retorno (ROI)");
    expect(roi).toContain("n.a.");
  });

  it("shows the ROI variation in percentage points", () => {
    const html = renderToStaticMarkup(
      <KpiCards current={summary({ roi: 0.3 })} previous={summary({ roi: 0.177 })} />,
    );

    expect(card(html, "roi")).toContain("+12,3 p.p.");
  });

  it("inverts the color of a falling cost per FTD (good)", () => {
    const html = renderToStaticMarkup(
      <KpiCards current={summary({ costPerFtd: 80 })} previous={summary({ costPerFtd: 100 })} />,
    );

    const cpf = card(html, "costPerFtd");
    expect(cpf).toContain("▼ 20,0%");
    expect(cpf).toContain("text-emerald-400");
  });

  it("renders the six cards in order, one column under sm", () => {
    const html = renderToStaticMarkup(<KpiCards current={summary()} previous={summary()} />);

    const order = ["cashResult", "roi", "adSpend", "net", "ftds", "costPerFtd"].map((key) =>
      html.indexOf(`data-kpi="${key}"`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("sm:grid-cols-3");
  });

  it("adds the house count to the profit label when given", () => {
    const html = renderToStaticMarkup(
      <KpiCards current={summary()} previous={summary()} houseCount={5} />,
    );

    expect(html).toContain("Lucro líquido (5 casas)");
  });

  it("notes an estimated GGR under the cards", () => {
    expect(GGR_ESTIMATED_NOTE).toBe("GGR estimado a partir do total do mês.");
    const estimated = renderToStaticMarkup(
      <KpiCards current={summary({ ggrEstimated: true })} previous={summary()} />,
    );
    expect(estimated).toContain("GGR estimado a partir do total do mês.");

    const exact = renderToStaticMarkup(<KpiCards current={summary()} previous={summary()} />);
    expect(exact).not.toContain("GGR estimado");
  });
});
