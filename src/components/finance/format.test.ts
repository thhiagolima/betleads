import { describe, expect, it } from "vitest";

import {
  betleadsUsageNote,
  formatBRL,
  formatPct,
  formatPp,
  formatRatio,
  monthLabel,
} from "./format";

describe("formatBRL", () => {
  it("formats money with two decimals and no NBSP", () => {
    expect(formatBRL(1234.5)).toBe("R$ 1.234,50");
  });

  it("formats null as n.a.", () => {
    expect(formatBRL(null)).toBe("n.a.");
  });
});

describe("formatPct", () => {
  it("formats a fraction as a percentage with one decimal", () => {
    expect(formatPct(0.3855)).toBe("38,6%");
  });

  it("formats null as n.a.", () => {
    expect(formatPct(null)).toBe("n.a.");
  });
});

describe("formatRatio", () => {
  it("formats null as n.a.", () => {
    expect(formatRatio(null)).toBe("n.a.");
  });
});

describe("formatPp", () => {
  it("formats a signed difference in percentage points", () => {
    expect(formatPp(12.3)).toBe("+12,3 p.p.");
    expect(formatPp(-4.25)).toBe("-4,3 p.p.");
    expect(formatPp(0)).toBe("+0,0 p.p.");
  });

  it("formats null as n.a.", () => {
    expect(formatPp(null)).toBe("n.a.");
  });
});

describe("monthLabel", () => {
  it("names the month in pt-BR, with the year on request", () => {
    expect(monthLabel("2026-10")).toBe("out");
    expect(monthLabel("2026-02", true)).toBe("fev/2026");
  });
});

describe("betleadsUsageNote", () => {
  it("says there is no consumption data when the house never had any", () => {
    expect(betleadsUsageNote("2026-10", null)).toBe("sem dado de consumo");
  });

  it("names the since month for a month before it", () => {
    expect(betleadsUsageNote("2026-09", "2026-10-10")).toBe(
      "sem dado de consumo antes de out/2026",
    );
    expect(betleadsUsageNote("2025-12", "2026-01-03")).toBe(
      "sem dado de consumo antes de jan/2026",
    );
  });

  it("is null from the since month on", () => {
    expect(betleadsUsageNote("2026-10", "2026-10-10")).toBeNull();
    expect(betleadsUsageNote("2026-11", "2026-10-10")).toBeNull();
  });
});
