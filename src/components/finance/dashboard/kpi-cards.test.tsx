import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GGR_ESTIMATED_NOTE, KpiCards, NO_FEE_NOTE } from "./kpi-cards";
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
  it("notes the result has no mensalidade when the window is not a closed month", () => {
    const open = renderToStaticMarkup(
      <KpiCards current={summary({ betleadsFee: null, otherCosts: 50 })} previous={summary()} />,
    );
    expect(open).toContain("Resultado sem a mensalidade do mês (entra no fechamento do mês).");
    expect(NO_FEE_NOTE).toBe("Resultado sem a mensalidade do mês (entra no fechamento do mês).");
    // Other costs enter any window by date: no note about them.
    expect(open).not.toContain("outros custos");

    const closed = renderToStaticMarkup(
      <KpiCards current={summary({ betleadsFee: 0 })} previous={summary()} />,
    );
    expect(closed).not.toContain("entra no fechamento do mês");
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

  it("renders 3 highlighted then 5 support cards in order, one column under sm", () => {
    const html = renderToStaticMarkup(<KpiCards current={summary()} previous={summary()} />);

    const keys = [
      "cashResult",
      "roi",
      "adSpend",
      "deposits",
      "withdrawals",
      "net",
      "ftds",
      "costPerFtd",
    ];
    const order = keys.map((key) => html.indexOf(`data-kpi="${key}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/data-kpi=/g)).toHaveLength(8);

    const highlighted = html.slice(0, html.indexOf('data-kpi-row="support"'));
    expect(highlighted).toContain("grid-cols-1 gap-2 sm:grid-cols-3");
    expect(highlighted).toContain('data-kpi="adSpend"');
    expect(highlighted).not.toContain('data-kpi="deposits"');
    const support = html.slice(html.indexOf('data-kpi-row="support"'));
    expect(support).toContain("grid-cols-1");
    expect(support).toContain("lg:grid-cols-5");
  });

  it("shows deposits and withdrawals with their variation; withdrawals invert the color", () => {
    const html = renderToStaticMarkup(
      <KpiCards
        current={summary({ depositAmount: 1100, withdrawalAmount: 600, net: 500 })}
        previous={summary({ depositAmount: 1000, withdrawalAmount: 500, net: 500 })}
      />,
    );

    const deposits = card(html, "deposits");
    expect(deposits).toContain("Depósitos");
    expect(deposits).toContain("R$ 1.100,00");
    expect(deposits).toContain("▲ 10,0%");
    expect(deposits).toContain("text-emerald-400");

    const withdrawals = card(html, "withdrawals");
    expect(withdrawals).toContain("Saques");
    expect(withdrawals).toContain("R$ 600,00");
    expect(withdrawals).toContain("▲ 20,0%");
    expect(withdrawals).toContain("text-rose-400");

    const net = card(html, "net");
    expect(net).toContain("Net (depósitos − saques)");
    expect(net).toContain("R$ 500,00");
  });

  it("a rising cost per FTD is red", () => {
    const html = renderToStaticMarkup(
      <KpiCards current={summary({ costPerFtd: 120 })} previous={summary({ costPerFtd: 100 })} />,
    );
    const cpf = card(html, "costPerFtd");
    expect(cpf).toContain("Custo por FTD");
    expect(cpf).toContain("▲ 20,0%");
    expect(cpf).toContain("text-rose-400");
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
