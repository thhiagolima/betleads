import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { trendDisplay } from "@/lib/home-dashboard";

import { KpiCard } from "./home-cards";

describe("KpiCard", () => {
  it("shows a drop with a down arrow in the negative tone", () => {
    const html = renderToStaticMarkup(
      <KpiCard title="Ticket médio" value="R$ 76,23" trend={trendDisplay(-3.1)} />,
    );
    expect(html).toContain("↓ 3,1%");
    expect(html).toContain("text-rose-400");
    expect(html).not.toContain("↑");
  });

  it("shows a rise with an up arrow in the positive tone", () => {
    const html = renderToStaticMarkup(
      <KpiCard title="Depositado" value="R$ 10" trend={trendDisplay(12.4)} />,
    );
    expect(html).toContain("↑ 12,4%");
    expect(html).toContain("text-emerald-400");
  });

  it("omits the trend when it is not a finite number", () => {
    const html = renderToStaticMarkup(
      <KpiCard title="FTD" value="0" trend={trendDisplay(Number.NaN)} />,
    );
    expect(html).not.toMatch(/[↑↓→]/);
  });
});
