import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { ResultBand } from "./result-band";
import { kpis, summary } from "./test-fixtures";

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/** The markup of one card (data-result="<key>") up to the next card. */
function card(html: string, key: string) {
  const start = html.indexOf(`data-result="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-result=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("ResultBand", () => {
  it("ResultBand shows ROI with the previous-month reference", () => {
    const html = render(
      <ResultBand
        current={summary({ cashResult: 1150, adSpend: 1000, roi: 1.15, net: 2300 })}
        previous={summary({ cashResult: 1000, adSpend: 1000, roi: 1, net: 2000 })}
        kpis={{ current: kpis({ margin: 0.5 }), previous: kpis({ margin: 0.5 }) }}
        roiReference={{ roi: 0.8, range: { from: "2026-09-01", to: "2026-09-29" } }}
      />,
    );

    const roi = card(html, "roi");
    expect(roi).toContain("Retorno (ROI)");
    expect(roi).toContain("115,0%");
    expect(roi).toContain("mês anterior: 80,0%");
    expect(roi).toContain("+15,0 p.p.");
    expect(roi).toContain('aria-label="Como calculamos"');

    const profit = card(html, "cashResult");
    expect(profit).toContain("Lucro líquido");
    expect(profit).toContain("▲ 15,0%");
    expect(profit).toContain("text-emerald-400");

    const margin = card(html, "margin");
    expect(margin).toContain("Margem");
    expect(margin).toContain("50,0%");
    expect(margin).toContain("+0,0 p.p.");

    const ads = card(html, "adSpend");
    expect(ads).toContain("Anúncios");
    expect(ads).toContain("R$ 1.000,00");
  });

  it("shows n.a. for the reference when the previous month has no ROI, and red when ads rise", () => {
    const html = render(
      <ResultBand
        current={summary({ adSpend: 1200 })}
        previous={summary({ adSpend: 1000 })}
        kpis={{ current: kpis(), previous: kpis() }}
        roiReference={{ roi: null, range: { from: "2026-09-01", to: "2026-09-30" } }}
        houseCount={3}
      />,
    );

    expect(card(html, "roi")).toContain("mês anterior: n.a.");
    expect(card(html, "adSpend")).toContain("▲ 20,0%");
    expect(card(html, "adSpend")).toContain("text-rose-400");
    expect(card(html, "cashResult")).toContain("Lucro líquido (3 casas)");
    expect(html).toContain("sm:grid-cols-2");
  });
});
