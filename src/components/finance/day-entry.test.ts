import { describe, expect, it } from "vitest";

import { computeDay } from "@/lib/finance/calc";
import type { FinanceDay, FinanceDayInput } from "@/lib/finance/types";

import { dayResult, dayStatus, metaFillEntries, neighborDays } from "./day-entry";

function day(overrides: Partial<FinanceDayInput> = {}): FinanceDay {
  return computeDay({
    date: "2026-10-10",
    registrations: 10,
    ftds: 2,
    ftdDepositAmount: 100,
    depositAmount: 1000,
    withdrawalAmount: 400,
    adSpend: 50,
    adSpendSuggested: null,
    ggr: 300,
    ggrFeePct: 0,
    movementFeePct: 0,
    ...overrides,
  });
}

describe("day-entry", () => {
  it("dayStatus covers each case", () => {
    expect(dayStatus(day())).toBe("completo");
    expect(dayStatus(day({ adSpend: null }))).toBe("falta anúncios");
    expect(dayStatus(day({ ggr: null }))).toBe("falta GGR");
    expect(dayStatus(day({ adSpend: null, ggr: null }))).toBe("falta anúncios e GGR");
    expect(dayStatus(day({ ggrEstimated: true }))).toBe("estimado");
    // An estimated GGR with no ads still lacks the ads.
    expect(dayStatus(day({ ggrEstimated: true, adSpend: null }))).toBe("falta anúncios");
  });

  it("neighborDays stops at month end and at today", () => {
    const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
    expect(neighborDays(dates, "2026-10-01", "2026-10-31")).toEqual({
      prev: null,
      next: "2026-10-02",
    });
    expect(neighborDays(dates, "2026-10-02", "2026-10-31")).toEqual({
      prev: "2026-10-01",
      next: "2026-10-03",
    });
    // Last date of the month: no next.
    expect(neighborDays(dates, "2026-10-03", "2026-10-31")).toEqual({
      prev: "2026-10-02",
      next: null,
    });
    // Today: nothing after it, even if listed.
    expect(neighborDays(dates, "2026-10-02", "2026-10-02")).toEqual({
      prev: "2026-10-01",
      next: null,
    });
    // Unordered input and a current day missing from the list.
    expect(neighborDays(["2026-10-05", "2026-10-01"], "2026-10-03", "2026-10-31")).toEqual({
      prev: "2026-10-01",
      next: "2026-10-05",
    });
  });

  it("metaFillEntries lists only empty days with a suggestion", () => {
    const days = [
      day({ date: "2026-10-01", adSpend: null, adSpendSuggested: 120.5 }),
      day({ date: "2026-10-02", adSpend: 80, adSpendSuggested: 90 }),
      day({ date: "2026-10-03", adSpend: null, adSpendSuggested: null }),
      day({ date: "2026-10-04", adSpend: null, adSpendSuggested: 0 }),
    ];
    expect(metaFillEntries(days)).toEqual([
      { date: "2026-10-01", adSpend: 120.5 },
      { date: "2026-10-04", adSpend: 0 },
    ]);
    expect(metaFillEntries([day()])).toEqual([]);
  });

  it("dayResult takes the day's sends and other costs off the day's cash result", () => {
    const d = day();
    const result = dayResult(
      d,
      [{ item: "sms", units: 100, amount: 12, missingCostUnits: 0 }],
      [
        { valor: 30, categoria: "Equipe" },
        { valor: 8, categoria: "Equipe" },
      ],
    );
    expect(result.sendCost).toBe(12);
    expect(result.summary.cashResult).toBeCloseTo(d.cashResult - 12 - 38);
    const last = result.steps[result.steps.length - 1];
    expect(last.label).toBe("Lucro líquido");
    expect(last.end).toBeCloseTo(result.summary.cashResult);
    expect(result.steps.find((s) => s.key === "category:Equipe")?.start).toBeDefined();
  });
});
