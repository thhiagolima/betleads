import { describe, expect, it } from "vitest";

import type { MonthPoint } from "@/lib/finance/types";

import {
  costPerPlayerReason,
  emptyMonth,
  formatMultiple,
  ggrNotLaunched,
  monthName,
  pendingTitle,
  periodHasData,
  periodLabel,
  shortStepLabel,
  trendStartHint,
  visibleChange,
} from "./display";
import { summary } from "./test-fixtures";

const month = (m: string, overrides: Partial<MonthPoint> = {}): MonthPoint => ({
  month: m,
  cashResult: 0,
  adSpend: 0,
  net: 0,
  depositAmount: 0,
  roi: null,
  incomplete: false,
  inProgress: false,
  betleadsMissing: false,
  byTenant: {},
  ...overrides,
});

describe("periodHasData", () => {
  it("is false for an all-zero period and true when anything moved", () => {
    expect(periodHasData(summary())).toBe(false);
    expect(periodHasData(summary({ depositAmount: 10 }))).toBe(true);
    expect(periodHasData(summary({ adSpend: 5 }))).toBe(true);
    expect(periodHasData(summary({ registrations: 1 }))).toBe(true);
    expect(periodHasData(summary({ cashResult: -3 }))).toBe(true);
  });
});

describe("visibleChange", () => {
  it("is hidden without a previous period with data", () => {
    expect(visibleChange(120, 100, { hasPrevious: false })).toBeNull();
    expect(visibleChange(120, null, { hasPrevious: true })).toBeNull();
    expect(visibleChange(null, 100, { hasPrevious: true })).toBeNull();
    expect(visibleChange(120, 0, { hasPrevious: true })).toBeNull();
  });

  it("is the % change, or the points change for ratios", () => {
    expect(visibleChange(120, 100, { hasPrevious: true })).toBeCloseTo(0.2);
    expect(visibleChange(0.5, 0.4, { hasPrevious: true, points: true })).toBeCloseTo(10);
  });
});

describe("missing-value reasons", () => {
  it("cost per player has no value without ads", () => {
    expect(costPerPlayerReason(summary({ adSpend: 0 }))).toBe("sem anúncios");
    expect(costPerPlayerReason(summary({ adSpend: 10 }))).toBeNull();
  });

  it("GGR is not launched when it is 0 with pending days", () => {
    expect(ggrNotLaunched(summary({ ggr: 0, pendingDays: 3 }))).toBe(true);
    expect(ggrNotLaunched(summary({ ggr: 0, pendingDays: 0 }))).toBe(false);
    expect(ggrNotLaunched(summary({ ggr: 50, pendingDays: 3 }))).toBe(false);
  });
});

describe("formatMultiple", () => {
  it("shows a return as a multiple", () => {
    expect(formatMultiple(2.345)).toBe("2,3×");
    expect(formatMultiple(0)).toBe("0×");
    expect(formatMultiple(12)).toBe("12×");
  });
});

describe("pendingTitle", () => {
  it("names the count and the month, without listing the dates", () => {
    const dates = Array.from({ length: 28 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    expect(pendingTitle(dates)).toBe("28 dias de outubro sem anúncios ou GGR lançados.");
    expect(pendingTitle(["2026-10-07"])).toBe("1 dia de outubro sem anúncios ou GGR lançados.");
    expect(pendingTitle(["2026-09-30", "2026-10-01"])).toBe(
      "2 dias de setembro e outubro sem anúncios ou GGR lançados.",
    );
  });
});

describe("periodLabel", () => {
  it("names a month window by its month and other windows by their dates", () => {
    expect(periodLabel({ from: "2026-10-01", to: "2026-10-31" })).toBe("outubro de 2026");
    expect(periodLabel({ from: "2026-10-01", to: "2026-10-28" })).toBe("outubro de 2026");
    expect(periodLabel({ from: "2026-10-22", to: "2026-10-28" })).toBe("22/10 a 28/10/2026");
    expect(periodLabel({ from: "2026-10-28", to: "2026-10-28" })).toBe("28/10/2026");
    expect(monthName("2026-03")).toBe("março");
  });
});

describe("shortStepLabel", () => {
  it("abbreviates the long step names", () => {
    expect(shortStepLabel("Taxa de movimentação")).toBe("Taxa de mov.");
    expect(shortStepLabel("Depósitos")).toBe("Depósitos");
  });
});

describe("emptyMonth", () => {
  it("is a month with no cash, net or deposits before the data starts", () => {
    expect(emptyMonth(month("2026-05"), "2026-10-22")).toBe(true);
    expect(emptyMonth(month("2026-05"), null)).toBe(true);
    expect(emptyMonth(month("2026-05", { depositAmount: 1 }), "2026-10-22")).toBe(false);
    expect(emptyMonth(month("2026-05", { cashResult: -1 }), "2026-10-22")).toBe(false);
    // All zero after the data starts but with ads still counts as data.
    expect(emptyMonth(month("2026-11", { adSpend: 10 }), "2026-10-22")).toBe(false);
    expect(emptyMonth(month("2026-11"), "2026-10-22")).toBe(true);
  });
});

describe("trendStartHint", () => {
  it("tells where the data starts when fewer than 3 months have it", () => {
    const months = [month("2026-08"), month("2026-09"), month("2026-10", { cashResult: -72 })];
    expect(trendStartHint(months, null)).toBe(
      "Os dados financeiros desta casa começam em outubro de 2026.",
    );
    const full = [
      month("2026-08", { net: 1 }),
      month("2026-09", { net: 1 }),
      month("2026-10", { net: 1 }),
    ];
    expect(trendStartHint(full, null)).toBeNull();
    expect(trendStartHint([month("2026-10")], null)).toBeNull();
  });
});
