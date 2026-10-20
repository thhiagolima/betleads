import { describe, expect, it } from "vitest";

import { brtHour, greetingFor, periodRange, trendDisplay } from "./home-dashboard";

describe("trendDisplay", () => {
  it("shows a rise as up and positive", () => {
    expect(trendDisplay(12.44)).toEqual({ direction: "up", tone: "positive", label: "↑ 12,4%" });
  });

  it("shows a drop as down and negative instead of ↑ 0,0%", () => {
    expect(trendDisplay(-30)).toEqual({ direction: "down", tone: "negative", label: "↓ 30,0%" });
  });

  it("treats changes that round to zero as flat", () => {
    expect(trendDisplay(0.04)?.direction).toBe("flat");
    expect(trendDisplay(-0.04)?.label).toBe("→ 0,0%");
  });

  it("labels rate differences in percentage points", () => {
    expect(trendDisplay(1.2, "pp")?.label).toBe("↑ 1,2 p.p.");
  });

  it("hides non-finite values", () => {
    expect(trendDisplay(Number.NaN)).toBeNull();
    expect(trendDisplay(Number.POSITIVE_INFINITY)).toBeNull();
    expect(trendDisplay(undefined)).toBeNull();
  });
});

describe("greetingFor", () => {
  it("uses Brasília time, not the browser's", () => {
    // 14:30 UTC = 11:30 in Brasília
    expect(brtHour(new Date("2026-10-20T14:30:00Z"))).toBe(11);
    expect(greetingFor(new Date("2026-10-20T14:30:00Z"))).toBe("Bom dia");
    expect(greetingFor(new Date("2026-10-20T16:00:00Z"))).toBe("Boa tarde");
    expect(greetingFor(new Date("2026-10-20T22:00:00Z"))).toBe("Boa noite");
    // 02:00 UTC is still 23:00 of the previous day in Brasília
    expect(greetingFor(new Date("2026-10-21T02:00:00Z"))).toBe("Boa noite");
  });
});

describe("periodRange", () => {
  const now = new Date(2026, 9, 20, 15, 0, 0);

  it("covers the last 7 days including today", () => {
    const range = periodRange("7d", now);
    expect(range.from?.getDate()).toBe(14);
    expect(range.to?.getDate()).toBe(20);
  });

  it("covers the whole previous month", () => {
    const range = periodRange("last_month", now);
    expect(range.from?.getMonth()).toBe(8);
    expect(range.from?.getDate()).toBe(1);
    expect(range.to?.getDate()).toBe(30);
  });
});
