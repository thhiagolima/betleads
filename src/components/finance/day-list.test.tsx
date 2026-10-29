import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { computeDay } from "@/lib/finance/calc";

import { DayList } from "./day-list";

describe("DayList", () => {
  it("one row per day with status, Net, Envios and Lucro líquido", () => {
    const day = computeDay({
      date: "2026-10-05",
      registrations: 1,
      ftds: 0,
      ftdDepositAmount: 0,
      depositAmount: 500,
      withdrawalAmount: 100,
      adSpend: null,
      adSpendSuggested: null,
      ggr: 0,
      ggrFeePct: 0,
      movementFeePct: 0,
    });
    const html = renderToStaticMarkup(
      <DayList
        days={[day]}
        sendsByDay={{ "2026-10-05": [{ item: "sms", units: 10, amount: 7, missingCostUnits: 0 }] }}
        otherCosts={[{ costDate: "2026-10-05", valor: 3, categoria: "Outros" }]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("05/10");
    expect(html).toContain("falta anúncios");
    expect(html).toContain("R$ 400,00"); // Net
    expect(html).toContain("R$ 7,00"); // Envios
    expect(html).toContain("R$ 390,00"); // Lucro líquido: 400 − 7 − 3
    expect(html).not.toContain("<table");
    // One name per number: the full labels.
    expect(html).toContain("Net (depósitos − saques)");
    expect(html).toContain("Lucro líquido");
  });
});
