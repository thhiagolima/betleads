import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { betleadsMissingNote } from "@/components/finance/format";
import type { MonthPoint } from "@/lib/finance/types";

import { ProfitTrendChart, trendValue } from "./profit-trend-chart";

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
