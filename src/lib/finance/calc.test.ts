import { describe, expect, it } from "vitest";
import fixtureDays from "./__fixtures__/pixreals-outubro.json";
import {
  averageFilledAdSpend,
  compareRange,
  computeDay,
  costBreakdown,
  dependsOnManual,
  evaluateGoal,
  isSumMetric,
  isWholeMonth,
  metricValue,
  pctChange,
  ppChange,
  presetRange,
  round2,
  summarize,
} from "./calc";
import type { FinanceDay, FinanceDayInput, GoalDay, PeriodSummary } from "./types";

type FixtureRow = {
  date: string;
  ads: number;
  registrations: number;
  ftds: number;
  ftdDeposits: number;
  deposits: number;
  withdrawals: number;
  net: number;
  ggr: number;
  roi: number;
  cashResult: number;
};

const rows = fixtureDays as FixtureRow[];

function toInput(row: FixtureRow): FinanceDayInput {
  return {
    date: row.date,
    registrations: row.registrations,
    ftds: row.ftds,
    ftdDepositAmount: row.ftdDeposits,
    depositAmount: row.deposits,
    withdrawalAmount: row.withdrawals,
    adSpend: row.ads,
    adSpendSuggested: null,
    ggr: row.ggr,
    ggrFeePct: 16,
    movementFeePct: 2.7,
  };
}

describe("round2", () => {
  it("round2 matches Excel", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(2185.3035)).toBe(2185.3);
  });
});

describe("computeDay", () => {
  it("matches every October day of the spreadsheet", () => {
    for (const row of rows) {
      const day = computeDay(toInput(row));
      expect(day.cashResult).not.toBeNull();
      expect(day.net).not.toBeNull();
      expect(day.cashResult as number).toBeCloseTo(row.cashResult, 2);
      expect(day.net as number).toBeCloseTo(row.net, 2);
    }
  });

  it("negative net lowers the movement fee", () => {
    const day = computeDay({
      date: "2026-10-01",
      registrations: 1,
      ftds: 1,
      ftdDepositAmount: 0,
      depositAmount: 100,
      withdrawalAmount: 300,
      adSpend: 0,
      adSpendSuggested: null,
      ggr: 0,
      ggrFeePct: 16,
      movementFeePct: 2.7,
    });

    expect(day.cashResult).toBeCloseTo(-205.4, 2);
  });
});

describe("summarize", () => {
  it("matches the October month close", () => {
    const days = rows.map((row) => computeDay(toInput(row)));
    const summary = summarize(days, 0);

    expect(summary.cashResult).toBeCloseTo(43706.07, 2);
    expect(summary.movementFee).toBeCloseTo(27979.78, 2);
    expect(summary.ggrFee).toBeCloseTo(39431.51, 2);
    expect(summary.adSpend).toBeCloseTo(113362.15, 2);
    expect(summary.roi as number).toBeCloseTo(0.3855437639, 6);
    expect(summary.avgDailyCashResult as number).toBeCloseTo(2185.3035, 4);
  });

  it("pending days", () => {
    const days: FinanceDay[] = [
      computeDay({
        date: "2026-10-01",
        registrations: 10,
        ftds: 1,
        ftdDepositAmount: 100,
        depositAmount: 1000,
        withdrawalAmount: 200,
        adSpend: 50,
        adSpendSuggested: null,
        ggr: 500,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      }),
      computeDay({
        date: "2026-10-02",
        registrations: 12,
        ftds: 1,
        ftdDepositAmount: 100,
        depositAmount: 1100,
        withdrawalAmount: 210,
        adSpend: 60,
        adSpendSuggested: null,
        ggr: null,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      }),
      computeDay({
        date: "2026-10-03",
        registrations: 11,
        ftds: 1,
        ftdDepositAmount: 100,
        depositAmount: 1200,
        withdrawalAmount: 220,
        adSpend: 70,
        adSpendSuggested: null,
        ggr: 600,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      }),
    ];

    const summary = summarize(days, null);
    expect(summary.pendingDays).toBe(1);
    expect(summary.ftds).toBe(3);
    // Only the 2 complete days (10-01: 616, 10-03: 749.2); the pending 10-02 is excluded.
    expect(summary.cashResult).toBeCloseTo(1365.2, 2);

    const range = { from: "2026-10-01", to: "2026-10-03" };

    const cashResultGoal = evaluateGoal(
      [{ date: "2026-10-01", metric: "cash_result", direction: "gte", dailyValue: 0 }],
      summary,
      range,
    );
    expect(cashResultGoal?.status).toBe("gray");

    const ftdsGoal = evaluateGoal(
      [{ date: "2026-10-01", metric: "ftds", direction: "gte", dailyValue: 1 }],
      summary,
      range,
    );
    expect(ftdsGoal?.status).not.toBe("gray");
  });

  it("a pending today is not a pending day", () => {
    const day = (date: string, ggr: number | null) =>
      computeDay({
        date,
        registrations: 10,
        ftds: 1,
        ftdDepositAmount: 100,
        depositAmount: 1000,
        withdrawalAmount: 200,
        adSpend: 50,
        adSpendSuggested: null,
        ggr,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      });
    const days = [day("2026-10-23", 500), day("2026-10-24", null)];

    const withToday = summarize(days, null, "2026-10-24");
    expect(withToday.pendingDays).toBe(0);
    expect(withToday.pendingToday).toBe(true);
    // Resultado still sums only the complete day (10-23: 616).
    expect(withToday.cashResult).toBeCloseTo(616, 2);

    const withoutToday = summarize(days, null);
    expect(withoutToday.pendingDays).toBe(1);
    expect(withoutToday.pendingToday).toBe(false);

    const range = { from: "2026-10-23", to: "2026-10-24" };
    const goalDays: GoalDay[] = [
      { date: "2026-10-23", metric: "cash_result", direction: "gte", dailyValue: 600 },
      { date: "2026-10-24", metric: "cash_result", direction: "gte", dailyValue: 600 },
    ];
    const goal = evaluateGoal(goalDays, withToday, range, "2026-10-24");
    // Not gray, and today's goal day is left out of the target like its value.
    expect(goal?.status).toBe("green");
    expect(goal?.target).toBe(600);

    const onlyToday = evaluateGoal(
      [goalDays[1]],
      summarize([days[1]], null, "2026-10-24"),
      { from: "2026-10-24", to: "2026-10-24" },
      "2026-10-24",
    );
    expect(onlyToday?.status).toBe("gray");
  });

  it("pendingDays counts distinct dates across houses", () => {
    const pendingDay = (date: string) =>
      computeDay({
        date,
        registrations: 0,
        ftds: 0,
        ftdDepositAmount: 0,
        depositAmount: 0,
        withdrawalAmount: 0,
        adSpend: null,
        adSpendSuggested: null,
        ggr: null,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      });
    const days = [
      pendingDay("2026-10-22"),
      pendingDay("2026-10-22"),
      pendingDay("2026-10-23"),
      pendingDay("2026-10-24"),
      pendingDay("2026-10-24"),
    ];
    expect(summarize(days, null, "2026-10-24").pendingDays).toBe(2);
  });

  it("other costs only reduce the period result when provided", () => {
    const days = rows.slice(0, 3).map((row) => computeDay(toInput(row)));
    const withoutCosts = summarize(days, null);
    const withZeroCosts = summarize(days, 0);
    const withCosts = summarize(days, 100);

    expect(withoutCosts.cashResult).toBe(withZeroCosts.cashResult);
    expect(withCosts.cashResult).toBeCloseTo(withoutCosts.cashResult - 100, 2);
    expect(withCosts.net).toBe(withoutCosts.net);
    expect(withCosts.ggrFee).toBe(withoutCosts.ggrFee);
    expect(withCosts.movementFee).toBe(withoutCosts.movementFee);
  });

  it("deducts Betleads usage and fee from cashResult and ROI", () => {
    const day = (date: string, adSpend: number, depositAmount: number) =>
      computeDay({
        date,
        registrations: 0,
        ftds: 0,
        ftdDepositAmount: 0,
        depositAmount,
        withdrawalAmount: 0,
        adSpend,
        adSpendSuggested: null,
        ggr: 0,
        ggrFeePct: 0,
        movementFeePct: 0,
      });
    // Two complete days: cashResult sums to 1000 (500 + 500), adSpend sums to 500.
    const days = [day("2026-10-01", 300, 800), day("2026-10-02", 200, 700)];

    const summary = summarize(days, 100, undefined, { usage: 50, fee: 4000 });

    expect(summary.cashResult).toBe(-3150);
    expect(summary.roi).toBeCloseTo(-6.3, 6);
    expect(summary.betleadsUsage).toBe(50);
    expect(summary.betleadsFee).toBe(4000);
  });

  it("without betleads keeps today's numbers", () => {
    const days = rows.map((row) => computeDay(toInput(row)));
    const summary = summarize(days, 0);

    expect(summary.cashResult).toBeCloseTo(43706.07, 2);
    expect(summary.betleadsUsage).toBe(0);
    expect(summary.betleadsFee).toBeNull();
  });

  it("zero ad spend gives null ROI and pctChange from negative previous is positive", () => {
    const days = [
      computeDay({
        date: "2026-10-01",
        registrations: 1,
        ftds: 0,
        ftdDepositAmount: 0,
        depositAmount: 100,
        withdrawalAmount: 0,
        adSpend: 0,
        adSpendSuggested: null,
        ggr: 0,
        ggrFeePct: 0,
        movementFeePct: 0,
      }),
    ];
    const summary = summarize(days, null);
    expect(summary.roi).toBeNull();
    expect(pctChange(-50, -100)).toBeCloseTo(0.5, 6);
  });
});

describe("costBreakdown", () => {
  const summaryWith = (overrides: Partial<PeriodSummary>): PeriodSummary => ({
    days: 1,
    pendingDays: 0,
    pendingToday: false,
    registrations: 0,
    ftds: 0,
    ftdDepositAmount: 0,
    depositAmount: 0,
    withdrawalAmount: 0,
    adSpend: 0,
    ggr: 0,
    net: 0,
    ggrFee: 0,
    movementFee: 0,
    otherCosts: null,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    betleadsUsage: 0,
    betleadsFee: null,
    ...overrides,
  });

  it("orders by amount, labels the GGR rate, marks Betleads auto, drops empty lines", () => {
    const current = summaryWith({
      adSpend: 100,
      ggrFee: 50,
      movementFee: 20,
      betleadsUsage: 10,
      betleadsFee: 0,
    });
    const categories = { Equipe: 30, Ferramentas: 0 };

    const lines = costBreakdown(current, null, categories, null, 16);

    expect(lines.map((l) => l.key)).toEqual([
      "ad_spend",
      "ggr_fee",
      "category:Equipe",
      "movement_fee",
      "betleads",
    ]);
    expect(lines.find((l) => l.key === "ggr_fee")?.label).toBe("Taxa de GGR (16%)");
    const betleadsLine = lines.find((l) => l.key === "betleads");
    expect(betleadsLine?.label).toBe("Betleads");
    expect(betleadsLine?.auto).toBe(true);
    expect(betleadsLine?.amount).toBe(10);
    // Ferramentas (0, no previous) is dropped.
    expect(lines.some((l) => l.key === "category:Ferramentas")).toBe(false);
  });

  it("labels the GGR line without a rate when ggrFeePct is null", () => {
    const current = summaryWith({ ggrFee: 10 });
    const lines = costBreakdown(current, null, {}, null, null);
    expect(lines.find((l) => l.key === "ggr_fee")?.label).toBe("Taxa de GGR");
  });

  it("keeps a line whose previous amount was non-zero even if current is now zero", () => {
    const current = summaryWith({ adSpend: 0 });
    const previous = summaryWith({ adSpend: 200 });
    const lines = costBreakdown(current, previous, {}, null, null);
    const adLine = lines.find((l) => l.key === "ad_spend");
    expect(adLine?.amount).toBe(0);
    expect(adLine?.previous).toBe(200);
  });
});

describe("averageFilledAdSpend", () => {
  it("divides by the days with Anúncios filled, not by every day", () => {
    const day = (date: string, adSpend: number | null) =>
      computeDay({
        date,
        registrations: 0,
        ftds: 0,
        ftdDepositAmount: 0,
        depositAmount: 0,
        withdrawalAmount: 0,
        adSpend,
        adSpendSuggested: null,
        ggr: null,
        ggrFeePct: 16,
        movementFeePct: 2.7,
      });
    expect(
      averageFilledAdSpend([
        day("2026-10-01", 100),
        day("2026-10-02", null),
        day("2026-10-03", 50),
      ]),
    ).toBe(75);
    expect(averageFilledAdSpend([day("2026-10-01", null)])).toBeNull();
  });
});

describe("goals", () => {
  const baseSummary: PeriodSummary = {
    days: 1,
    pendingDays: 0,
    pendingToday: false,
    registrations: 0,
    ftds: 0,
    ftdDepositAmount: 0,
    depositAmount: 0,
    withdrawalAmount: 0,
    adSpend: 0,
    ggr: 0,
    net: 0,
    ggrFee: 0,
    movementFee: 0,
    otherCosts: null,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    betleadsUsage: 0,
    betleadsFee: null,
  };
  const range = { from: "2026-10-01", to: "2026-10-01" };

  it.each([
    ["gte" as const, 100, 100, "green"],
    ["gte" as const, 100, 80, "yellow"],
    ["gte" as const, 100, 79, "red"],
    ["lte" as const, 90, 90, "green"],
    ["lte" as const, 90, 108, "yellow"],
    ["lte" as const, 90, 109, "red"],
    ["gte" as const, 0, 0.01, "green"],
    ["gte" as const, 0, -0.01, "red"],
  ])("goal bands: %s %s with value %s is %s", (direction, target, value, expected) => {
    const summary: PeriodSummary = { ...baseSummary, ftds: value, roi: value };
    const metric = target === 0 ? "roi" : "ftds";
    const goalDays: GoalDay[] = [{ date: range.from, metric, direction, dailyValue: target }];

    const evaluation = evaluateGoal(goalDays, summary, range);
    expect(evaluation?.status).toBe(expected);
  });

  it("sum goal target is the sum of each day's goal", () => {
    const goalDays: GoalDay[] = [];
    for (let day = 1; day <= 9; day += 1) {
      goalDays.push({
        date: `2026-10-${String(day).padStart(2, "0")}`,
        metric: "ftds",
        direction: "gte",
        dailyValue: 100,
      });
    }
    goalDays.push({ date: "2026-10-10", metric: "ftds", direction: "gte", dailyValue: 120 });

    const summary: PeriodSummary = { ...baseSummary, ftds: 1020 };
    const range = { from: "2026-10-01", to: "2026-10-10" };

    const evaluation = evaluateGoal(goalDays, summary, range);
    expect(evaluation?.target).toBe(1020);
  });

  it("ratio goal uses the last day's value", () => {
    const goalDays: GoalDay[] = [
      { date: "2026-10-01", metric: "cost_per_ftd", direction: "lte", dailyValue: 100 },
      { date: "2026-10-10", metric: "cost_per_ftd", direction: "lte", dailyValue: 90 },
    ];
    const summary: PeriodSummary = { ...baseSummary, costPerFtd: 90 };
    const range = { from: "2026-10-01", to: "2026-10-15" };

    const evaluation = evaluateGoal(goalDays, summary, range);
    expect(evaluation?.target).toBe(90);
    expect(evaluation?.status).toBe("green");
  });

  it("returns null when there are no goal days", () => {
    expect(evaluateGoal([], baseSummary, range)).toBeNull();
  });
});

describe("metricValue, isSumMetric, dependsOnManual", () => {
  it("maps metrics to summary fields", () => {
    const summary: PeriodSummary = {
      days: 1,
      pendingDays: 0,
      pendingToday: false,
      registrations: 5,
      ftds: 2,
      ftdDepositAmount: 10,
      depositAmount: 100,
      withdrawalAmount: 20,
      adSpend: 30,
      ggr: 40,
      net: 80,
      ggrFee: 1,
      movementFee: 2,
      otherCosts: null,
      cashResult: 50,
      roi: 0.5,
      costPerRegistration: 6,
      costPerFtd: 15,
      avgDailyCashResult: 50,
      betleadsUsage: 0,
      betleadsFee: null,
    };

    expect(metricValue(summary, "registrations")).toBe(5);
    expect(metricValue(summary, "ftds")).toBe(2);
    expect(metricValue(summary, "deposits")).toBe(100);
    expect(metricValue(summary, "net")).toBe(80);
    expect(metricValue(summary, "cash_result")).toBe(50);
    expect(metricValue(summary, "cost_per_registration")).toBe(6);
    expect(metricValue(summary, "cost_per_ftd")).toBe(15);
    expect(metricValue(summary, "roi")).toBe(0.5);
  });

  it("isSumMetric is true only for sum metrics", () => {
    expect(isSumMetric("registrations")).toBe(true);
    expect(isSumMetric("ftds")).toBe(true);
    expect(isSumMetric("deposits")).toBe(true);
    expect(isSumMetric("net")).toBe(true);
    expect(isSumMetric("cash_result")).toBe(true);
    expect(isSumMetric("cost_per_registration")).toBe(false);
    expect(isSumMetric("cost_per_ftd")).toBe(false);
    expect(isSumMetric("roi")).toBe(false);
  });

  it("dependsOnManual is false only for registrations, ftds and deposits", () => {
    expect(dependsOnManual("registrations")).toBe(false);
    expect(dependsOnManual("ftds")).toBe(false);
    expect(dependsOnManual("deposits")).toBe(false);
    expect(dependsOnManual("net")).toBe(true);
    expect(dependsOnManual("cash_result")).toBe(true);
    expect(dependsOnManual("cost_per_registration")).toBe(true);
    expect(dependsOnManual("cost_per_ftd")).toBe(true);
    expect(dependsOnManual("roi")).toBe(true);
  });
});

describe("presetRange", () => {
  it("presetRange uses Sao Paulo", () => {
    const now = new Date("2026-10-25T02:00:00Z");
    expect(presetRange("today", now)).toEqual({ from: "2026-10-24", to: "2026-10-24" });
  });

  it("7d covers the 7 days up to today, inclusive", () => {
    const now = new Date("2026-10-25T02:00:00Z");
    expect(presetRange("7d", now)).toEqual({ from: "2026-10-18", to: "2026-10-24" });
  });

  it("month covers day 1 to today", () => {
    const now = new Date("2026-10-25T02:00:00Z");
    expect(presetRange("month", now)).toEqual({ from: "2026-10-01", to: "2026-10-24" });
  });

  it("yesterday", () => {
    const now = new Date("2026-10-25T02:00:00Z");
    expect(presetRange("yesterday", now)).toEqual({ from: "2026-10-23", to: "2026-10-23" });
  });
});

describe("compareRange", () => {
  it("previous: window of the same size immediately before", () => {
    expect(compareRange({ from: "2026-10-10", to: "2026-10-16" }, "previous", "7d")).toEqual({
      from: "2026-10-03",
      to: "2026-10-09",
    });
  });

  it("previous month: 31-day month compared to a shorter month", () => {
    expect(compareRange({ from: "2026-03-01", to: "2026-03-31" }, "previous", "month")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("previous month: in-progress month compared up to the same day", () => {
    expect(compareRange({ from: "2026-10-01", to: "2026-10-24" }, "previous", "month")).toEqual({
      from: "2026-09-01",
      to: "2026-09-24",
    });
  });

  it("previous: a custom range that is exactly a calendar month compares with the whole previous month", () => {
    expect(compareRange({ from: "2026-09-01", to: "2026-09-30" }, "previous", "custom")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(compareRange({ from: "2026-03-01", to: "2026-03-31" }, "previous", "custom")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("last_week shifts the window back 7 days", () => {
    expect(compareRange({ from: "2026-10-24", to: "2026-10-24" }, "last_week", "today")).toEqual({
      from: "2026-10-17",
      to: "2026-10-17",
    });
  });
});

describe("pctChange", () => {
  it("computes the percentage change", () => {
    expect(pctChange(110, 100)).toBeCloseTo(0.1, 6);
  });

  it("is null when prev is null or 0", () => {
    expect(pctChange(10, null)).toBeNull();
    expect(pctChange(10, 0)).toBeNull();
  });

  it("improving from a negative previous is positive", () => {
    expect(pctChange(500, -1000)).toBeCloseTo(1.5, 6);
    expect(pctChange(-1500, -1000)).toBeCloseTo(-0.5, 6);
  });
});

describe("ppChange", () => {
  it("is the difference in percentage points", () => {
    expect(ppChange(0.3, 0.177)).toBeCloseTo(12.3, 6);
    expect(ppChange(-0.1, 0.2)).toBeCloseTo(-30, 6);
  });

  it("is null when either side is null", () => {
    expect(ppChange(null, 0.2)).toBeNull();
    expect(ppChange(0.2, null)).toBeNull();
  });
});

describe("isWholeMonth", () => {
  it("is true only for the 1st to the last day of one month", () => {
    expect(isWholeMonth({ from: "2026-09-01", to: "2026-09-30" })).toBe(true);
    expect(isWholeMonth({ from: "2026-02-01", to: "2026-02-28" })).toBe(true);
    expect(isWholeMonth({ from: "2026-09-01", to: "2026-09-29" })).toBe(false);
    expect(isWholeMonth({ from: "2026-09-02", to: "2026-09-30" })).toBe(false);
  });
});
