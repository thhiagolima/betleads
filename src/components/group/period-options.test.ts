import { describe, expect, it } from "vitest";

import {
  calendarFooter,
  compareOptions,
  formatDay,
  formatRange,
  matchShortcut,
  periodFromRange,
  periodFromShortcut,
  periodLabel,
  presetFor,
  QUICK_SHORTCUTS,
  shortcutRange,
  type PeriodShortcut,
} from "./period-options";

// 2026-10-29 is a Thursday.
const TODAY = "2026-10-29";

describe("shortcutRange", () => {
  const cases: Array<[PeriodShortcut, string, string]> = [
    ["today", "2026-10-29", "2026-10-29"],
    ["yesterday", "2026-10-28", "2026-10-28"],
    ["7d", "2026-10-23", "2026-10-29"],
    ["15d", "2026-10-15", "2026-10-29"],
    ["30d", "2026-09-30", "2026-10-29"],
    ["this_week", "2026-10-26", "2026-10-29"],
    ["last_week", "2026-10-19", "2026-10-25"],
    ["this_month", "2026-10-01", "2026-10-29"],
    ["last_month", "2026-09-01", "2026-09-30"],
    ["3m", "2026-08-01", "2026-10-29"],
    ["this_year", "2026-01-01", "2026-10-29"],
  ];
  it.each(cases)("%s", (shortcut, from, to) => {
    expect(shortcutRange(shortcut, TODAY)).toEqual({ from, to });
  });

  it("weeks run Monday to Sunday (a Sunday is the end of its week)", () => {
    expect(shortcutRange("this_week", "2026-11-01")).toEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
    expect(shortcutRange("this_week", "2026-10-26")).toEqual({
      from: "2026-10-26",
      to: "2026-10-26",
    });
  });

  it("last month and the last 3 months cross the year", () => {
    expect(shortcutRange("last_month", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(shortcutRange("3m", "2026-02-10")).toEqual({ from: "2025-12-01", to: "2026-02-10" });
  });
});

describe("presetFor", () => {
  it("Este mês is the month preset; today, yesterday and 7 days keep theirs", () => {
    expect(presetFor("this_month", shortcutRange("this_month", TODAY), TODAY)).toBe("month");
    expect(presetFor("today", shortcutRange("today", TODAY), TODAY)).toBe("today");
    expect(presetFor("yesterday", shortcutRange("yesterday", TODAY), TODAY)).toBe("yesterday");
    expect(presetFor("7d", shortcutRange("7d", TODAY), TODAY)).toBe("7d");
  });

  it("every other choice is custom, unless its range matches a preset exactly", () => {
    expect(presetFor("last_month", shortcutRange("last_month", TODAY), TODAY)).toBe("custom");
    expect(presetFor("30d", shortcutRange("30d", TODAY), TODAY)).toBe("custom");
    expect(presetFor(null, { from: "2026-10-05", to: "2026-10-12" }, TODAY)).toBe("custom");
    expect(presetFor(null, { from: TODAY, to: TODAY }, TODAY)).toBe("today");
    expect(presetFor(null, { from: "2026-10-23", to: TODAY }, TODAY)).toBe("7d");
  });
});

describe("matchShortcut", () => {
  it("finds the shortcut of a picked range, the first one when several match", () => {
    expect(matchShortcut({ from: "2026-09-01", to: "2026-09-30" }, TODAY)).toBe("last_month");
    expect(matchShortcut({ from: "2026-10-23", to: TODAY }, TODAY)).toBe("7d");
    expect(matchShortcut({ from: "2026-10-05", to: "2026-10-12" }, TODAY)).toBeNull();
    // On a Monday "Esta semana" is today.
    expect(matchShortcut({ from: "2026-10-26", to: "2026-10-26" }, "2026-10-26")).toBe("today");
  });
});

describe("month-to-date of the current month is always Este mês", () => {
  it.each([
    ["2026-10-07", "7d"],
    ["2026-10-15", "15d"],
  ] as const)(
    "on %s the calendar range and the %s shortcut give the month preset",
    (today, shortcut) => {
      const range = { from: "2026-10-01", to: today };
      expect(matchShortcut(range, today)).toBe("this_month");
      expect(periodFromRange(range, "previous", today)).toMatchObject({
        shortcut: "this_month",
        preset: "month",
      });
      const clicked = periodFromShortcut(shortcut, "previous", today);
      expect(clicked.range).toEqual(range);
      expect(clicked.preset).toBe("month");
      expect(compareOptions(clicked, today)[0]).toMatchObject({
        label: "Mês anterior",
        dates: `01/09 a ${today.slice(8)}/09`,
      });
    },
  );

  it("a single day stays a day, even on the 1st", () => {
    expect(matchShortcut({ from: "2026-11-01", to: "2026-11-01" }, "2026-11-01")).toBe("today");
  });
});

describe("formatDay / formatRange", () => {
  it("uses dd/mm, adding /aa when the year differs from today's", () => {
    expect(formatDay("2026-10-01", TODAY)).toBe("01/10");
    expect(formatDay("2025-10-29", TODAY)).toBe("29/10/25");
  });

  it("one day is one date; a range is 'a'-joined", () => {
    expect(formatRange({ from: TODAY, to: TODAY }, TODAY)).toBe("29/10");
    expect(formatRange({ from: "2026-10-01", to: TODAY }, TODAY)).toBe("01/10 a 29/10");
    expect(formatRange({ from: "2025-10-01", to: "2025-10-29" }, TODAY)).toBe(
      "01/10/25 a 29/10/25",
    );
  });

  it("the calendar footer has full dates and the number of days", () => {
    expect(calendarFooter({ from: "2026-10-01", to: TODAY })).toBe(
      "01/10/2026 a 29/10/2026 · 29 dias",
    );
    expect(calendarFooter({ from: TODAY, to: TODAY })).toBe("29/10/2026 a 29/10/2026 · 1 dia");
  });
});

describe("periodLabel", () => {
  it("names the shortcut and shows its dates", () => {
    const period = periodFromShortcut("this_month", "previous", TODAY);
    expect(periodLabel(period, TODAY)).toEqual({ name: "Este mês", dates: "01/10 a 29/10" });
    expect(periodLabel(periodFromShortcut("today", "previous", TODAY), TODAY)).toEqual({
      name: "Hoje",
      dates: "29/10",
    });
  });

  it("a picked range is Personalizado", () => {
    const period = periodFromRange({ from: "2026-10-05", to: "2026-10-12" }, "previous", TODAY);
    expect(periodLabel(period, TODAY)).toEqual({
      name: "Personalizado",
      dates: "05/10 a 12/10",
    });
  });
});

describe("compareOptions", () => {
  const labels = (options: ReturnType<typeof compareOptions>) =>
    options.map((option) => [option.label, option.dates]);

  it("one day: previous day, same weekday last week, same day last year, none", () => {
    const period = periodFromShortcut("today", "previous", TODAY);
    expect(labels(compareOptions(period, TODAY))).toEqual([
      ["Dia anterior", "28/10"],
      ["Mesmo dia da semana passada", "22/10"],
      ["Mesmo dia do ano passado", "29/10/25"],
      ["Sem comparação", null],
    ]);
    expect(compareOptions(period, TODAY).map((option) => option.mode)).toEqual([
      "previous",
      "same_weekday_last_week",
      "same_period_last_year",
      "none",
    ]);
  });

  it("month (Este mês, Mês passado or a whole calendar month)", () => {
    expect(
      labels(compareOptions(periodFromShortcut("this_month", "previous", TODAY), TODAY)),
    ).toEqual([
      ["Mês anterior", "01/09 a 29/09"],
      ["Mesmo mês do ano passado", "01/10/25 a 29/10/25"],
      ["Sem comparação", null],
    ]);
    expect(
      labels(compareOptions(periodFromShortcut("last_month", "previous", TODAY), TODAY)),
    ).toEqual([
      ["Mês anterior", "01/08 a 31/08"],
      ["Mesmo mês do ano passado", "01/09/25 a 30/09/25"],
      ["Sem comparação", null],
    ]);
    const august = periodFromRange({ from: "2026-08-01", to: "2026-08-31" }, "previous", TODAY);
    expect(compareOptions(august, TODAY)[0].label).toBe("Mês anterior");
  });

  it("Este mês on the 1st is still a month", () => {
    const period = periodFromShortcut("this_month", "previous", "2026-11-01");
    expect(compareOptions(period, "2026-11-01")[0]).toMatchObject({
      label: "Mês anterior",
      dates: "01/10",
    });
  });

  it("anything else: previous period, same period last year, none", () => {
    expect(labels(compareOptions(periodFromShortcut("7d", "previous", TODAY), TODAY))).toEqual([
      ["Período anterior", "16/10 a 22/10"],
      ["Mesmo período do ano passado", "23/10/25 a 29/10/25"],
      ["Sem comparação", null],
    ]);
  });

  it("a compare mode not offered for the new period falls back to the first option", () => {
    expect(periodFromShortcut("7d", "same_weekday_last_week", TODAY).compare).toBe("previous");
    expect(periodFromShortcut("today", "same_weekday_last_week", TODAY).compare).toBe(
      "same_weekday_last_week",
    );
    expect(periodFromShortcut("7d", "none", TODAY).compare).toBe("none");
    expect(periodFromShortcut("this_month", "last_week", TODAY).compare).toBe("previous");
  });
});

describe("periodFromShortcut", () => {
  it("builds the period sent to the server", () => {
    expect(periodFromShortcut("last_month", "previous", TODAY)).toEqual({
      shortcut: "last_month",
      preset: "custom",
      range: { from: "2026-09-01", to: "2026-09-30" },
      compare: "previous",
    });
    expect(periodFromShortcut("this_month", "same_period_last_year", TODAY)).toEqual({
      shortcut: "this_month",
      preset: "month",
      range: { from: "2026-10-01", to: "2026-10-29" },
      compare: "same_period_last_year",
    });
  });

  it("the quick chips", () => {
    expect(QUICK_SHORTCUTS.map((chip) => chip.label)).toEqual([
      "Hoje",
      "Ontem",
      "7 dias",
      "30 dias",
      "Este mês",
      "Mês passado",
    ]);
  });
});
