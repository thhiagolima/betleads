import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { summary } from "@/components/finance/dashboard/test-fixtures";

import { MonthSummary } from "./finance-month-grid";

/** The markup of one tile (data-tile="<key>") up to the next tile. */
function tile(html: string, key: string) {
  const start = html.indexOf(`data-tile="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("data-tile=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("MonthSummary (Lançamentos)", () => {
  it("Envios and Mensalidade are two tiles, each with its own term", () => {
    const html = renderToStaticMarkup(
      <MonthSummary
        summary={summary({ betleadsUsage: 12.345, betleadsFee: 4000, cashResult: 100 })}
        sendCostIncomplete={false}
        betleadsNote={null}
      />,
    );
    expect(html).not.toContain("Envios e mensalidade");
    expect(tile(html, "sends")).toContain("Envios");
    expect(tile(html, "sends")).toContain("R$ 12,35");
    expect(tile(html, "fee")).toContain("Mensalidade");
    expect(tile(html, "fee")).toContain("R$ 4.000,00");
    expect(tile(html, "sends")).not.toContain("custo do provedor não cadastrado");
  });

  it("a partial Envios says the provider cost is missing; the usage note stays on Envios", () => {
    const html = renderToStaticMarkup(
      <MonthSummary
        summary={summary({ betleadsUsage: 5, betleadsFee: null })}
        sendCostIncomplete
        betleadsNote="Sem dado de custo Betleads antes de out/2026"
      />,
    );
    expect(tile(html, "sends")).toContain("R$ 5,00");
    expect(tile(html, "sends")).toContain("+ custo do provedor não cadastrado");
    expect(tile(html, "sends")).toContain("Sem dado de custo Betleads antes de out/2026");
    expect(tile(html, "fee")).toContain("R$ 0,00");
  });
});
