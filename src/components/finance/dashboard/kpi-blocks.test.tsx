import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { FinanceKpis, PeriodSummary } from "@/lib/finance/types";

import { GGR_ESTIMATED_NOTE, KpiBlocks } from "./kpi-blocks";
import { kpis, summary } from "./test-fixtures";

const render = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

/** The markup of one block (data-block="<key>") up to the next block. */
function block(html: string, key: string) {
  const start = html.indexOf(`data-block="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-block=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The markup of one row (data-kpi="<key>") up to the next row. */
function row(html: string, key: string) {
  const start = html.indexOf(`data-kpi="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-kpi=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

function renderBlocks({
  current = summary(),
  previous = summary(),
  currentKpis = kpis(),
  previousKpis = kpis(),
}: {
  current?: PeriodSummary;
  previous?: PeriodSummary;
  currentKpis?: FinanceKpis;
  previousKpis?: FinanceKpis;
}) {
  return render(
    <KpiBlocks
      totals={{ current, previous }}
      kpis={{ current: currentKpis, previous: previousKpis }}
      sends={[]}
      exemptHouse={false}
      betleadsNote={null}
    />,
  );
}

describe("KpiBlocks", () => {
  it("renders the four titled blocks, one column under sm", () => {
    const html = renderBlocks({});
    for (const title of ["Movimentação", "Aquisição", "GGR", "Envios e CRM"]) {
      expect(html).toContain(`>${title}<`);
    }
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("sm:grid-cols-2");
  });

  it("KpiBlocks hides Meta KPIs when null and shows n.a. for null ratios", () => {
    const html = renderBlocks({});
    const acquisition = block(html, "acquisition");

    expect(acquisition).not.toContain("CPM");
    expect(acquisition).not.toContain("CTR");
    expect(acquisition).not.toContain("Custo por clique");
    expect(row(html, "registrationToFtd")).toContain("Cadastro → FTD");
    expect(row(html, "registrationToFtd")).toContain("n.a.");
    expect(row(html, "withdrawalShare")).toContain("Saques ÷ depósitos");
    expect(row(html, "withdrawalShare")).toContain("n.a.");
    expect(row(html, "pixConversion")).toContain("Pix gerado → pago");
    expect(row(html, "ggrShareOfDeposits")).toContain("n.a.");

    const withMeta = renderBlocks({
      currentKpis: kpis({ cpm: 12.5, ctr: 0.02, costPerClick: 0.75 }),
    });
    const meta = block(withMeta, "acquisition");
    expect(meta).toContain("CPM");
    expect(meta).toContain("R$ 12,50");
    expect(meta).toContain("CTR");
    expect(meta).toContain("2,0%");
    expect(meta).toContain("Custo por clique");
    expect(meta).toContain("R$ 0,75");
  });

  it("shows amounts with counts and inverts the color of saques", () => {
    const html = renderBlocks({
      current: summary({ depositAmount: 5000, withdrawalAmount: 1200, net: 3800 }),
      previous: summary({ depositAmount: 4000, withdrawalAmount: 1000, net: 3000 }),
      currentKpis: kpis({ depositCount: 40, withdrawalCount: 12, depositorsPerDay: 7.25 }),
    });

    const deposits = row(html, "deposits");
    expect(deposits).toContain("R$ 5.000,00");
    expect(deposits).toContain("40 depósitos");
    expect(deposits).toContain("▲ 25,0%");
    expect(deposits).toContain("text-emerald-400");

    const withdrawals = row(html, "withdrawals");
    expect(withdrawals).toContain("R$ 1.200,00");
    expect(withdrawals).toContain("12 saques");
    expect(withdrawals).toContain("▲ 20,0%");
    expect(withdrawals).toContain("text-rose-400");

    expect(row(html, "net")).toContain("Net (depósitos − saques)");
    expect(row(html, "depositorsPerDay")).toContain("7,3");
    for (const label of ["Ticket médio", "Saque médio"]) expect(html).toContain(label);
    for (const label of [
      "Anúncios",
      "Cadastros",
      "FTDs",
      "Custo por cadastro",
      "Custo por FTD",
      "FTD médio",
    ]) {
      expect(block(html, "acquisition")).toContain(label);
    }
  });

  it("puts the GGR estimate note inside the GGR block", () => {
    const estimated = renderBlocks({
      current: summary({ ggr: 900, ggrFee: 90, ggrEstimated: true }),
    });
    const ggr = block(estimated, "ggr");
    expect(ggr).toContain("GGR (Perdas na casa)");
    expect(ggr).toContain("Taxa de GGR");
    expect(ggr).toContain("GGR ÷ depósitos");
    expect(ggr).toContain(GGR_ESTIMATED_NOTE);
    expect(GGR_ESTIMATED_NOTE).toBe("GGR estimado a partir do total do mês.");

    expect(renderBlocks({})).not.toContain(GGR_ESTIMATED_NOTE);
  });
});
