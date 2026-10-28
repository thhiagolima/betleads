import { describe, expect, it, vi } from "vitest";

import {
  FINANCE_DASHBOARD_QUERY_KEY,
  financeMonthQueryKey,
  invalidateFinanceAfterSave,
} from "./query-keys";

describe("invalidateFinanceAfterSave", () => {
  it("refreshes the house's month and every dashboard query", async () => {
    const invalidateQueries = vi.fn(async () => {});
    await invalidateFinanceAfterSave({ invalidateQueries }, "house-a", "2026-10");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["finance-month", "house-a", "2026-10"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["finance-dashboard"] });
    expect(financeMonthQueryKey("house-a", "2026-10")).toEqual([
      "finance-month",
      "house-a",
      "2026-10",
    ]);
    expect(FINANCE_DASHBOARD_QUERY_KEY).toEqual(["finance-dashboard"]);
  });
});
