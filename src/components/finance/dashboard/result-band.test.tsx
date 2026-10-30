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
    expect(roi).toContain('aria-label="Como calculamos"');

    const profit = card(html, "cashResult");
    expect(profit).toContain("Lucro líquido");
    expect(profit).toContain("▲ 15,0%");
    expect(profit).toContain("text-emerald-400");
    expect(profit).toContain("xl:text-[40px]");
    expect(profit).toContain("whitespace-nowrap");
    expect(profit).toContain("bg-emerald-500/");

    const margin = card(html, "margin");
    expect(margin).toContain("Margem");
    expect(margin).toContain("50,0%");
    expect(margin).toContain("lucro ÷ net");

    const ads = card(html, "adSpend");
    expect(ads).toContain("Anúncios");
    expect(ads).toContain("R$ 1.000,00");
    expect(ads).toContain("text-[22px]");
    expect(ads).toContain("xl:text-[30px]");
    expect(html).not.toContain("n.a.");
  });

  it("red when ads rise, and the house count on the profit label", () => {
    const html = render(
      <ResultBand
        current={summary({ adSpend: 1200, roi: 0.5, cashResult: -10 })}
        previous={summary({ adSpend: 1000 })}
        kpis={{ current: kpis(), previous: kpis() }}
        roiReference={{ roi: null, range: { from: "2026-09-01", to: "2026-09-30" } }}
        houseCount={3}
      />,
    );

    expect(card(html, "roi")).toContain("mês anterior: —");
    // The previous period has data but no comparable profit: no fallback text.
    expect(card(html, "cashResult")).not.toContain("Sem período anterior para comparar");
    expect(card(html, "adSpend")).toContain("▲ 20,0%");
    expect(card(html, "adSpend")).toContain("text-rose-400");
    expect(card(html, "cashResult")).toContain("Lucro líquido (3 casas)");
    expect(card(html, "cashResult")).toContain("bg-rose-500/");
    expect(html).toContain("xl:grid-cols-[1.6fr_1fr_1fr_1fr]");
    expect(card(html, "cashResult")).toContain("sm:col-span-2");
  });

  it("hides variations without a previous period and gives the reasons", () => {
    const html = render(
      <ResultBand
        current={summary({ cashResult: -72.06, adSpend: 0, roi: null, pendingDays: 28 })}
        previous={summary()}
        kpis={{ current: kpis({ margin: -0.122 }), previous: kpis() }}
        roiReference={{ roi: null, range: { from: "2026-09-01", to: "2026-09-30" } }}
      />,
    );

    expect(html).not.toContain("n.a.");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
    expect(card(html, "cashResult")).toContain("Sem período anterior para comparar");
    const roi = card(html, "roi");
    expect(roi).toContain("—");
    expect(roi).toContain("Sem anúncios no período");
    expect(roi).not.toContain("mês anterior");
    expect(card(html, "adSpend")).toContain("Nenhum dia lançado");
  });

  it("Sem comparação: the meta reads Sem comparação and no variation shows", () => {
    const html = render(
      <ResultBand
        current={summary({ cashResult: 2000, adSpend: 500, roi: 4 })}
        previous={summary({ cashResult: 1000, adSpend: 1000, roi: 1 })}
        kpis={{ current: kpis(), previous: kpis() }}
        roiReference={{ roi: 1, range: { from: "2026-09-01", to: "2026-09-30" } }}
        comparing={false}
      />,
    );
    expect(card(html, "cashResult")).toContain("Sem comparação");
    expect(card(html, "adSpend")).toContain("Sem comparação");
    expect(html).not.toContain("Sem período anterior para comparar");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
    // The ROI reference is separate and stays.
    expect(card(html, "roi")).toContain("mês anterior");
  });
});
