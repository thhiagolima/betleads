import { describe, expect, it } from "vitest";
import fixtureDays from "./__fixtures__/pixreals-outubro.json";
import {
  allocateMonthlyGgr,
  averageFilledAdSpend,
  compareRange,
  computeDay,
  costBreakdown,
  evaluateGoal,
  hasPartialGgrEstimate,
  isSumMetric,
  isWholeMonth,
  metricValue,
  monthlyGgrPendingThrough,
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

  it("computes a day with missing Anúncios and GGR as 0, keeping the raw inputs null", () => {
    const day = computeDay({
      date: "2026-10-02",
      registrations: 4,
      ftds: 2,
      ftdDepositAmount: 100,
      depositAmount: 1100,
      withdrawalAmount: 210,
      adSpend: null,
      adSpendSuggested: null,
      ggr: null,
      ggrFeePct: 16,
      movementFeePct: 2.7,
    });

    expect(day.pending).toBe(true);
    expect(day.adSpend).toBeNull();
    expect(day.ggr).toBeNull();
    expect(day.net).toBe(890);
    expect(day.ggrFee).toBe(0);
    // 29,70 + 5,67 + 24,03
    expect(day.movementFee).toBeCloseTo(59.4, 2);
    expect(day.cashResult).toBeCloseTo(830.6, 2);
    // ROI stays null with no ad spend; cost-per is 0 / divisor.
    expect(day.roi).toBeNull();
    expect(day.costPerRegistration).toBe(0);
    expect(day.costPerFtd).toBe(0);
  });

  it("a day missing only GGR uses its Anúncios; missing only Anúncios uses its GGR", () => {
    const base = {
      date: "2026-10-03",
      registrations: 0,
      ftds: 0,
      ftdDepositAmount: 0,
      depositAmount: 1000,
      withdrawalAmount: 0,
      adSpendSuggested: null,
      ggrFeePct: 10,
      movementFeePct: 0,
    };
    const noGgr = computeDay({ ...base, adSpend: 200, ggr: null });
    expect(noGgr.pending).toBe(true);
    expect(noGgr.cashResult).toBe(800);
    expect(noGgr.roi).toBe(4);
    expect(noGgr.costPerRegistration).toBeNull();

    const noAds = computeDay({ ...base, adSpend: null, ggr: 500 });
    expect(noAds.pending).toBe(true);
    expect(noAds.ggrFee).toBe(50);
    expect(noAds.cashResult).toBe(950);
    expect(noAds.roi).toBeNull();
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
    // Every day counts; the pending 10-02 (no GGR) counts as GGR 0:
    // 10-01: 616, 10-02: 770.6, 10-03: 749.2.
    expect(summary.cashResult).toBeCloseTo(2135.8, 2);
    expect(summary.net).toBe(2670);
    expect(summary.ggr).toBe(1100);
    expect(summary.roi as number).toBeCloseTo(2135.8 / 180, 6);
    expect(summary.avgDailyCashResult as number).toBeCloseTo(2135.8 / 3, 4);

    const range = { from: "2026-10-01", to: "2026-10-03" };

    const cashResultGoal = evaluateGoal(
      [{ date: "2026-10-01", metric: "cash_result", direction: "gte", dailyValue: 0 }],
      summary,
      range,
    );
    // Pending days no longer gray a goal: it is judged on the computed value.
    expect(cashResultGoal?.status).toBe("green");

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
    // Resultado sums every day, today included (10-23: 616, 10-24: 696).
    expect(withToday.cashResult).toBeCloseTo(1312, 2);

    const withoutToday = summarize(days, null);
    expect(withoutToday.pendingDays).toBe(1);
    expect(withoutToday.pendingToday).toBe(false);

    const range = { from: "2026-10-23", to: "2026-10-24" };
    const goalDays: GoalDay[] = [
      { date: "2026-10-23", metric: "cash_result", direction: "gte", dailyValue: 600 },
      { date: "2026-10-24", metric: "cash_result", direction: "gte", dailyValue: 600 },
    ];
    const goal = evaluateGoal(goalDays, withToday, range);
    // Today's value is counted, so today's goal day is in the target too.
    expect(goal?.status).toBe("green");
    expect(goal?.target).toBe(1200);

    const onlyToday = evaluateGoal([goalDays[1]], summarize([days[1]], null, "2026-10-24"), {
      from: "2026-10-24",
      to: "2026-10-24",
    });
    // A pending today alone is judged on its computed value (696 >= 600).
    expect(onlyToday?.status).toBe("green");
    expect(onlyToday?.value).toBeCloseTo(696, 2);
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
    ggrEstimated: false,
    ...overrides,
  });

  it("orders by amount, labels the GGR rate, marks Envios and Mensalidade auto, drops empty lines", () => {
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
      "sends",
      "fee",
    ]);
    expect(lines.find((l) => l.key === "ggr_fee")?.label).toBe("Taxa de GGR (16%)");
    const sendsLine = lines.find((l) => l.key === "sends");
    expect(sendsLine?.label).toBe("Envios");
    expect(sendsLine?.auto).toBe(true);
    expect(sendsLine?.amount).toBe(10);
    const feeLine = lines.find((l) => l.key === "fee");
    expect(feeLine?.label).toBe("Mensalidade");
    expect(feeLine?.auto).toBe(true);
    expect(feeLine?.amount).toBe(0);
    // Only Envios and Mensalidade are "automático"; Anúncios and the fees are not.
    expect(lines.filter((l) => l.auto).map((l) => l.key)).toEqual(["sends", "fee"]);
    // Ferramentas (0, no previous) is dropped.
    expect(lines.some((l) => l.key === "category:Ferramentas")).toBe(false);
  });

  it("drops Mensalidade only when the fee (current and previous) is null", () => {
    const openWindow = summaryWith({ betleadsFee: null });
    expect(costBreakdown(openWindow, null, {}, null, null).some((l) => l.key === "fee")).toBe(
      false,
    );

    // A closed month with an actual R$ 0 invoice still shows the line.
    const zeroFee = summaryWith({ betleadsFee: 0 });
    const zeroLines = costBreakdown(zeroFee, null, {}, null, null);
    expect(zeroLines.find((l) => l.key === "fee")).toMatchObject({ amount: 0, previous: null });

    // Kept when only the previous window had a fee.
    const previousClosed = summaryWith({ betleadsFee: null });
    const previousFee = summaryWith({ betleadsFee: 500 });
    const lines = costBreakdown(previousClosed, previousFee, {}, null, null);
    expect(lines.find((l) => l.key === "fee")).toMatchObject({ amount: 0, previous: 500 });
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
    ggrEstimated: false,
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

  it("is gray only when the value is null, not because of pending days", () => {
    const goalDays: GoalDay[] = [
      { date: range.from, metric: "cash_result", direction: "gte", dailyValue: 100 },
    ];
    const pending: PeriodSummary = { ...baseSummary, pendingDays: 3, cashResult: 50 };
    expect(evaluateGoal(goalDays, pending, range)?.status).toBe("red");

    const roiGoal: GoalDay[] = [
      { date: range.from, metric: "roi", direction: "gte", dailyValue: 0.2 },
    ];
    expect(evaluateGoal(roiGoal, { ...baseSummary, roi: null }, range)?.status).toBe("gray");
  });

  it("returns null when there are no goal days", () => {
    expect(evaluateGoal([], baseSummary, range)).toBeNull();
  });
});

describe("metricValue, isSumMetric", () => {
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
      ggrEstimated: false,
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

describe("allocateMonthlyGgr", () => {
  const input = (date: string, deposit: number, withdrawal = 0, ggr: number | null = null) => ({
    date,
    registrations: 0,
    ftds: 0,
    ftdDepositAmount: 0,
    depositAmount: deposit,
    withdrawalAmount: withdrawal,
    adSpend: 0,
    adSpendSuggested: null,
    ggr,
    ggrFeePct: 17,
    movementFeePct: 0,
  });
  const sum = (values: Array<number | null>) =>
    round2(values.reduce<number>((total, value) => total + (value ?? 0), 0));

  it("without a monthly total returns the days unchanged, not estimated", () => {
    const days = [input("2026-10-01", 100, 0, 5)];
    const out = allocateMonthlyGgr(days, null);
    expect(out[0].ggr).toBe(5);
    expect(out[0].ggrEstimated).toBe(false);
  });

  it("splits by net max(deposit − withdrawal, 0) and the days sum exactly to the total", () => {
    const days = [
      input("2026-10-01", 300, 100), // net 200
      input("2026-10-02", 100, 400), // net negative → weight 0
      input("2026-10-03", 100), // net 100
    ];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 1497.15,
      validThrough: "2026-10-03",
    });
    expect(out.map((d) => d.ggr)).toEqual([998.1, 0, 499.05]);
    expect(out.every((d) => d.ggrEstimated)).toBe(true);
    expect(sum(out.map((d) => d.ggr))).toBe(1497.15);
  });

  it("puts the rounding remainder on the last allocated day", () => {
    const days = [input("2026-10-01", 1), input("2026-10-02", 1), input("2026-10-03", 1)];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 100,
      validThrough: "2026-10-03",
    });
    expect(out.map((d) => d.ggr)).toEqual([33.33, 33.33, 33.34]);
  });

  it("splits equally when every weight is zero", () => {
    const days = [input("2026-10-01", 0), input("2026-10-02", 50, 80)];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 10.01,
      validThrough: "2026-10-02",
    });
    expect(out.map((d) => d.ggr)).toEqual([5.01, 5]);
  });

  it("allocates a negative total the same way", () => {
    const days = [input("2026-10-01", 100), input("2026-10-02", 300)];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: -400,
      validThrough: "2026-10-02",
    });
    expect(out.map((d) => d.ggr)).toEqual([-100, -300]);
  });

  it("ignores stored daily GGR; days after validThrough are pending; other months untouched", () => {
    const days = [
      input("2026-09-30", 100, 0, 7),
      input("2026-10-01", 100, 0, 999),
      input("2026-10-02", 100, 0, 999),
      input("2026-10-03", 100, 0, 999),
    ];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 50,
      validThrough: "2026-10-02",
    });
    expect(out.map((d) => [d.date, d.ggr, d.ggrEstimated])).toEqual([
      ["2026-09-30", 7, false],
      ["2026-10-01", 25, true],
      ["2026-10-02", 25, true],
      ["2026-10-03", null, false],
    ]);
  });

  it("whole-month GGR fee equals total × rate through computeDay", () => {
    const days = [input("2026-10-01", 123.45), input("2026-10-02", 77.7), input("2026-10-03", 9)];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 1497.15,
      validThrough: "2026-10-03",
    }).map(computeDay);
    const summary = summarize(out, null);
    expect(summary.ggr).toBe(1497.15);
    expect(Math.abs(summary.ggrFee - 254.52)).toBeLessThanOrEqual(0.02);
    expect(out.every((d) => d.ggrEstimated)).toBe(true);
  });

  it("days after validThrough stay pending but count as GGR 0 in the results", () => {
    const days = [input("2026-10-01", 100), input("2026-10-02", 300)];
    const out = allocateMonthlyGgr(days, {
      month: "2026-10-01",
      ggr: 50,
      validThrough: "2026-10-01",
    }).map(computeDay);
    expect(out[1].ggr).toBeNull();
    expect(out[1].pending).toBe(true);
    expect(out[1].ggrFee).toBe(0);
    expect(out[1].cashResult).toBe(300);

    const summary = summarize(out, null, "2026-10-05");
    expect(summary.pendingDays).toBe(1);
    expect(summary.ggr).toBe(50);
    // 10-01: 100 − 17% of 50 = 91,50; 10-02: 300.
    expect(summary.cashResult).toBe(391.5);
  });
});

describe("hasPartialGgrEstimate", () => {
  const allocations = [{ month: "2026-10-01", validThrough: "2026-10-20" }];

  it("is true when the window holds some but not all allocated days", () => {
    expect(hasPartialGgrEstimate({ from: "2026-10-14", to: "2026-10-20" }, allocations)).toBe(true);
    expect(hasPartialGgrEstimate({ from: "2026-09-25", to: "2026-10-05" }, allocations)).toBe(true);
  });

  it("is false when the window holds all or none of them", () => {
    expect(hasPartialGgrEstimate({ from: "2026-10-01", to: "2026-10-24" }, allocations)).toBe(
      false,
    );
    expect(hasPartialGgrEstimate({ from: "2026-10-21", to: "2026-10-24" }, allocations)).toBe(
      false,
    );
    expect(hasPartialGgrEstimate(null, allocations)).toBe(false);
    expect(hasPartialGgrEstimate({ from: "2026-10-01", to: "2026-10-05" }, [])).toBe(false);
  });

  it("summarize carries the flag (false by default)", () => {
    expect(summarize([], null).ggrEstimated).toBe(false);
    expect(summarize([], null, undefined, undefined, { ggrEstimated: true }).ggrEstimated).toBe(
      true,
    );
  });
});

describe("monthlyGgrPendingThrough", () => {
  const allocations = [{ month: "2026-10-01", validThrough: "2026-10-20" }];

  const pending = (...dates: string[]) => dates.map((date) => ({ date, adSpend: 10 }));

  it("returns validThrough when every pending date is after the month's validThrough", () => {
    expect(monthlyGgrPendingThrough(pending("2026-10-21", "2026-10-23"), allocations)).toBe(
      "2026-10-20",
    );
  });

  it("is null when a pending date is not explained by a monthly total", () => {
    expect(monthlyGgrPendingThrough(pending("2026-10-10", "2026-10-21"), allocations)).toBeNull();
    expect(monthlyGgrPendingThrough(pending("2026-09-30", "2026-10-21"), allocations)).toBeNull();
    expect(monthlyGgrPendingThrough([], allocations)).toBeNull();
  });

  it("is null when a pending day after validThrough also misses Anúncios", () => {
    expect(
      monthlyGgrPendingThrough(
        [
          { date: "2026-10-21", adSpend: 10 },
          { date: "2026-10-22", adSpend: null },
        ],
        allocations,
      ),
    ).toBeNull();
    // Anúncios of 0 counts as filled.
    expect(monthlyGgrPendingThrough([{ date: "2026-10-21", adSpend: 0 }], allocations)).toBe(
      "2026-10-20",
    );
  });
});
