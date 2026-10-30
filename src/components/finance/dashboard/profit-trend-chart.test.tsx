import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { betleadsMissingNote } from "@/components/finance/format";
import type { MonthPoint } from "@/lib/finance/types";

import { ProfitTrendChart, trendChartTitle, trendDomain, trendValue } from "./profit-trend-chart";

const point = (month: string, betleadsMissing: boolean): MonthPoint => ({
  month,
  cashResult: 100,
  adSpend: 10,
  net: 200,
  depositAmount: 300,
  roi: 10,
  incomplete: false,
  inProgress: false,
  betleadsMissing,
  byTenant: {},
});

const render = (betleadsSince: string | null, missing = true) =>
  renderToStaticMarkup(
    <ProfitTrendChart
      months={[point("2026-09", missing), point("2026-10", false)]}
      tenants={[]}
      stacked={false}
      betleadsSince={betleadsSince}
    />,
  );

describe("ProfitTrendChart Betleads note", () => {
  it("uses the same wording as the Lançamentos grid", () => {
    expect(render("2026-10-03")).toContain(betleadsMissingNote("2026-10-03"));
    expect(render("2026-10-03")).toContain("Sem dado de custo Betleads antes de out/2026");
    expect(render(null)).toContain("Sem dado de custo Betleads<");
  });

  it("has no note when no month misses Betleads data", () => {
    expect(render("2026-09-01", false)).not.toContain("Sem dado de custo Betleads");
  });
});

describe("ProfitTrendChart metric toggle", () => {
  it("offers Lucro líquido | Net | Depósitos, Lucro líquido first and pressed", () => {
    const html = render("2026-09-01", false);
    const lucro = html.indexOf(">Lucro líquido</button>");
    const net = html.indexOf(">Net</button>");
    const deposits = html.indexOf(">Depósitos</button>");
    expect(lucro).toBeGreaterThan(-1);
    expect(net).toBeGreaterThan(lucro);
    expect(deposits).toBeGreaterThan(net);
    expect(html).toContain('aria-pressed="true"');
  });

  it("reads each metric from the MonthPoint fields", () => {
    const p = point("2026-10", false);
    expect(trendValue(p, "cashResult")).toBe(100);
    expect(trendValue(p, "net")).toBe(200);
    expect(trendValue(p, "depositAmount")).toBe(300);
  });
});

describe("12-month chart title follows the metric toggle", () => {
  it("only says the profit is stacked by house while Lucro líquido is shown", () => {
    expect(trendChartTitle(true, "cashResult")).toBe(
      "Últimos 12 meses (lucro líquido empilhado por casa)",
    );
    expect(trendChartTitle(true, "net")).toBe("Últimos 12 meses");
    expect(trendChartTitle(true, "depositAmount")).toBe("Últimos 12 meses");
    expect(trendChartTitle(false, "cashResult")).toBe("Últimos 12 meses");
  });

  it("a controlled metric is the pressed one", () => {
    const html = renderToStaticMarkup(
      <ProfitTrendChart
        months={[point("2026-10", false)]}
        tenants={[]}
        stacked
        betleadsSince={null}
        metric="net"
        onMetricChange={() => {}}
      />,
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>Net<\/button>/);
  });
});

describe("12-month chart layout", () => {
  it("centers zero with a symmetric domain when the series has negatives", () => {
    expect(trendDomain([-72, 0, 0])).toEqual([-72, 72]);
    expect(trendDomain([-50, 200])).toEqual([-200, 200]);
    expect(trendDomain([10, 40])).toEqual([0, 40]);
    expect(trendDomain([0, 0])).toEqual([0, 1]);
  });

  it("puts the title and a segmented toggle in the header", () => {
    const html = render("2026-09-01", false);
    expect(html).toContain(">Últimos 12 meses</h2>");
    expect(html.indexOf("</h2>")).toBeLessThan(html.indexOf('role="group"'));
  });

  it("says where the data starts when fewer than 3 months have it", () => {
    const empty = (month: string) => ({
      ...point(month, true),
      cashResult: 0,
      net: 0,
      depositAmount: 0,
      adSpend: 0,
    });
    const html = renderToStaticMarkup(
      <ProfitTrendChart
        months={[
          empty("2026-08"),
          empty("2026-09"),
          { ...point("2026-10", false), cashResult: -72 },
        ]}
        tenants={[]}
        stacked={false}
        betleadsSince="2026-10-22"
      />,
    );
    expect(html).toContain("Os dados financeiros desta casa começam em outubro de 2026.");
    const full = renderToStaticMarkup(
      <ProfitTrendChart
        months={[point("2026-08", false), point("2026-09", false), point("2026-10", false)]}
        tenants={[]}
        stacked={false}
        betleadsSince="2026-08-01"
      />,
    );
    expect(full).not.toContain("Os dados financeiros");
  });
});
