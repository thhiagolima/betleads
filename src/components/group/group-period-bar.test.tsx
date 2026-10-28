import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupPeriodBar, monthInputValue, monthPeriod } from "./group-period-bar";

const october = {
  preset: "month" as const,
  range: { from: "2026-10-01", to: "2026-10-27" },
  compare: "previous" as const,
};

// 2026-10-27 15:00 in São Paulo (UTC-3).
const NOW = new Date("2026-10-27T18:00:00Z");

describe("GroupPeriodBar month picker", () => {
  it("the current month is the Mês preset, compared up to the same day", () => {
    expect(monthPeriod("2026-10", NOW)).toEqual({
      preset: "month",
      range: { from: "2026-10-01", to: "2026-10-27" },
      compare: "previous",
    });
  });

  it("a past month stays the whole month even when picked from the current one", () => {
    expect(monthPeriod("2026-09", NOW)?.range).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthPeriod("2026-09", NOW)?.preset).toBe("custom");
  });

  it("a picked month is the whole calendar month compared with the previous one", () => {
    expect(monthPeriod("2026-09", NOW)).toEqual({
      preset: "custom",
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
    });
    expect(monthPeriod("2028-02", NOW)?.range.to).toBe("2028-02-29");
    expect(monthPeriod("", NOW)).toBeNull();
  });

  it("shows the month for the Mês preset or a whole month, empty otherwise", () => {
    expect(monthInputValue(october)).toBe("2026-10");
    expect(monthInputValue(monthPeriod("2026-10", NOW) ?? october)).toBe("2026-10");
    expect(monthInputValue(monthPeriod("2026-09", NOW) ?? october)).toBe("2026-09");
    expect(
      monthInputValue({
        ...october,
        preset: "7d",
        range: { from: "2026-10-21", to: "2026-10-27" },
      }),
    ).toBe("");
  });

  it("renders the month input only with monthPicker", () => {
    const off = renderToStaticMarkup(<GroupPeriodBar value={october} onChange={() => {}} />);
    expect(off).not.toContain('type="month"');

    const on = renderToStaticMarkup(
      <GroupPeriodBar value={october} onChange={() => {}} monthPicker />,
    );
    expect(on).toContain('type="month"');
    expect(on).toContain('value="2026-10"');
  });
});
