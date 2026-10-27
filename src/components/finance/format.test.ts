import { describe, expect, it } from "vitest";

import { formatBRL, formatPct, formatPp, formatRatio } from "./format";

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
