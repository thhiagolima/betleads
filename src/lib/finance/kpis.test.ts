import { describe, expect, it } from "vitest";
import { computeKpis, sendLines, sumActivity, waterfallSteps } from "./kpis";
import type { DayActivity, PeriodSummary, SendUsage } from "./types";

function summaryWith(overrides: Partial<PeriodSummary>): PeriodSummary {
  return {
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
    otherCosts: 0,
    cashResult: 0,
    roi: null,
    costPerRegistration: null,
    costPerFtd: null,
    avgDailyCashResult: null,
    betleadsUsage: 0,
    betleadsFee: null,
    ggrEstimated: false,
    ...overrides,
  };
}

function activityWith(overrides: Partial<DayActivity>): DayActivity {
  return {
    depositCount: 0,
    depositorCount: 0,
    withdrawalCount: 0,
    generatedPixCount: 0,
    crmSent: 0,
    crmClicks: 0,
    crmDirectConversions: 0,
    crmDirectRevenue: 0,
    crmInfluencedRevenue: 0,
    adImpressions: 0,
    adClicks: 0,
    ...overrides,
  };
}

function usage(
  item: SendUsage["item"],
  units: number,
  amount: number,
  missingCostUnits = 0,
): SendUsage {
  return { item, units, amount, missingCostUnits };
}

describe("sumActivity", () => {
  it("sums each field across days", () => {
    const days: DayActivity[] = [
      activityWith({ depositCount: 2, crmSent: 10, crmDirectRevenue: 10.5 }),
      activityWith({ depositCount: 3, crmSent: 5, crmDirectRevenue: 2.5 }),
    ];
    const sum = sumActivity(days);
    expect(sum.depositCount).toBe(5);
    expect(sum.crmSent).toBe(15);
    expect(sum.crmDirectRevenue).toBe(13);
  });

  it("sums to zero for an empty list", () => {
    const sum = sumActivity([]);
    expect(sum.depositCount).toBe(0);
    expect(sum.adImpressions).toBe(0);
  });
});

describe("computeKpis divides correctly", () => {
  it("ticketMedio, registrationToFtd, margin", () => {
    const summary = summaryWith({
      depositAmount: 1000,
      ftds: 5,
      registrations: 20,
      cashResult: 30,
      net: 300,
    });
    const activity = activityWith({ depositCount: 4 });
    const kpis = computeKpis(summary, activity, [], 1);

    expect(kpis.ticketMedio).toBe(250);
    expect(kpis.registrationToFtd).toBe(0.25);
    expect(kpis.margin).toBeCloseTo(0.1, 6);
  });

  it("saqueMedio, withdrawalShare, pixConversion, ftdMedio, ggrShareOfDeposits, cpm/ctr/costPerClick", () => {
    const summary = summaryWith({
      depositAmount: 2000,
      withdrawalAmount: 400,
      ftdDepositAmount: 150,
      ftds: 3,
      ggr: 500,
      adSpend: 100,
    });
    const activity = activityWith({
      depositCount: 10,
      withdrawalCount: 4,
      generatedPixCount: 20,
      adImpressions: 1000,
      adClicks: 50,
    });
    const kpis = computeKpis(summary, activity, [], 1);

    expect(kpis.saqueMedio).toBe(100);
    expect(kpis.withdrawalShare).toBe(0.2);
    expect(kpis.pixConversion).toBe(0.5);
    expect(kpis.ftdMedio).toBe(50);
    expect(kpis.ggrShareOfDeposits).toBe(0.25);
    expect(kpis.cpm).toBeCloseTo(100, 6); // (100 / 1000) * 1000
    expect(kpis.ctr).toBeCloseTo(0.05, 6);
    expect(kpis.costPerClick).toBeCloseTo(2, 6);
  });

  it("depositorsPerDay divides by the number of days", () => {
    const summary = summaryWith({});
    const activity = activityWith({ depositorCount: 30 });
    expect(computeKpis(summary, activity, [], 3).depositorsPerDay).toBe(10);
  });
});

describe("zero divisors give null, never Infinity or NaN", () => {
  it("every ratio with a 0 denominator is null", () => {
    const summary = summaryWith({});
    const activity = activityWith({});
    const kpis = computeKpis(summary, activity, [], 0);

    expect(kpis.margin).toBeNull();
    expect(kpis.ticketMedio).toBeNull();
    expect(kpis.saqueMedio).toBeNull();
    expect(kpis.depositorsPerDay).toBeNull();
    expect(kpis.withdrawalShare).toBeNull();
    expect(kpis.pixConversion).toBeNull();
    expect(kpis.registrationToFtd).toBeNull();
    expect(kpis.ftdMedio).toBeNull();
    expect(kpis.ggrShareOfDeposits).toBeNull();
    expect(kpis.crmDirectReturn).toBeNull();
    expect(kpis.crmInfluencedReturn).toBeNull();

    for (const value of Object.values(kpis)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("cpm, ctr and costPerClick are null with 0 impressions, even with clicks and spend", () => {
    const summary = summaryWith({ adSpend: 500 });
    const activity = activityWith({ adImpressions: 0, adClicks: 10 });
    const kpis = computeKpis(summary, activity, [], 1);

    expect(kpis.cpm).toBeNull();
    expect(kpis.ctr).toBeNull();
    expect(kpis.costPerClick).toBeNull();
  });

  it("costPerClick is null when impressions exist but clicks are 0", () => {
    const summary = summaryWith({ adSpend: 500 });
    const activity = activityWith({ adImpressions: 1000, adClicks: 0 });
    const kpis = computeKpis(summary, activity, [], 1);

    expect(kpis.cpm).toBeCloseTo(500, 6);
    expect(kpis.ctr).toBe(0);
    expect(kpis.costPerClick).toBeNull();
  });
});

describe("crm returns use send cost and are null with zero cost", () => {
  it("divides crm revenue by the sum of send usage amounts", () => {
    const summary = summaryWith({});
    const activity = activityWith({ crmDirectRevenue: 300, crmInfluencedRevenue: 150 });
    const sends = [usage("sms", 1000, 100), usage("voice_30s", 10, 50)];

    const kpis = computeKpis(summary, activity, sends, 1);
    expect(kpis.sendCost).toBe(150);
    expect(kpis.crmDirectReturn).toBe(2);
    expect(kpis.crmInfluencedReturn).toBe(1);
  });

  it("is null when there is no send cost", () => {
    const summary = summaryWith({});
    const activity = activityWith({ crmDirectRevenue: 300, crmInfluencedRevenue: 150 });

    const kpis = computeKpis(summary, activity, [], 1);
    expect(kpis.sendCost).toBe(0);
    expect(kpis.crmDirectReturn).toBeNull();
    expect(kpis.crmInfluencedReturn).toBeNull();
  });
});

describe("sendLines orders channels, computes unit cost and flags missing provider cost", () => {
  it("orders SMS, Voz, E-mail regardless of input order", () => {
    const current = [usage("email", 100, 50), usage("sms", 1000, 100), usage("voice_30s", 20, 40)];
    const lines = sendLines(current, null);

    expect(lines.map((l) => l.item)).toEqual(["sms", "voice_30s", "email"]);
    expect(lines.map((l) => l.label)).toEqual(["SMS", "Voz", "E-mail"]);
    expect(lines.map((l) => l.unitLabel)).toEqual(["envios", "blocos de 30 s", "e-mails"]);
  });

  it("only includes channels present in current", () => {
    const lines = sendLines([usage("sms", 100, 10)], null);
    expect(lines.map((l) => l.item)).toEqual(["sms"]);
  });

  it("computes unitCost = amount / units when units > 0 and cost is not missing", () => {
    const lines = sendLines([usage("sms", 1000, 120)], null);
    expect(lines[0].unitCost).toBe(0.12);
  });

  it("flags missing provider cost and never reports a real R$ 0 unit cost", () => {
    const lines = sendLines([usage("sms", 1000, 80, 200)], null);
    expect(lines[0].missingCost).toBe(true);
    expect(lines[0].unitCost).toBeNull();
  });

  it("unitCost is null when units is 0", () => {
    const lines = sendLines([usage("sms", 0, 0)], null);
    expect(lines[0].unitCost).toBeNull();
  });

  it("carries the matching previous amount, or null when absent/not compared", () => {
    const current = [usage("sms", 1000, 120), usage("email", 50, 10)];
    const previous = [usage("sms", 900, 100)];

    const lines = sendLines(current, previous);
    expect(lines.find((l) => l.item === "sms")?.previousAmount).toBe(100);
    expect(lines.find((l) => l.item === "email")?.previousAmount).toBeNull();

    const noCompare = sendLines(current, null);
    expect(noCompare.every((l) => l.previousAmount === null)).toBe(true);
  });
});

describe("waterfall ends at cashResult and omits Mensalidade when fee is null", () => {
  it("runs Depósitos down to Lucro líquido matching cashResult", () => {
    const summary = summaryWith({
      depositAmount: 10000,
      withdrawalAmount: 2000,
      net: 8000,
      ggrFee: 500,
      movementFee: 300,
      adSpend: 1000,
      betleadsUsage: 200,
      betleadsFee: 100,
      otherCosts: 50,
      cashResult: 8000 - 500 - 300 - 1000 - 200 - 100 - 50,
    });

    const steps = waterfallSteps(summary, summary.betleadsUsage, { Equipe: 50 });

    expect(steps[0]).toMatchObject({ key: "deposits", kind: "start", start: 0, end: 10000 });
    const total = steps[steps.length - 1];
    expect(total.kind).toBe("total");
    expect(total.label).toBe("Lucro líquido");
    expect(total.end).toBeCloseTo(summary.cashResult, 2);
    expect(steps.some((s) => s.key === "fee")).toBe(true);
  });

  it("omits Mensalidade when betleadsFee is null", () => {
    const summary = summaryWith({
      depositAmount: 1000,
      withdrawalAmount: 0,
      net: 1000,
      betleadsFee: null,
      cashResult: 1000,
    });
    const steps = waterfallSteps(summary, 0, {});
    expect(steps.some((s) => s.key === "fee")).toBe(false);
  });

  it("adds an Outros custos step for the residual when categories do not add up to otherCosts", () => {
    const summary = summaryWith({
      depositAmount: 1000,
      net: 1000,
      otherCosts: 150,
      cashResult: 850,
    });

    const short = waterfallSteps(summary, 0, { Equipe: 100 });
    expect(short.find((s) => s.key === "other_costs")).toEqual({
      key: "other_costs",
      label: "Outros custos",
      kind: "down",
      start: 900,
      end: 850,
    });
    expect(short.at(-1)?.end).toBe(850);

    // Categories above otherCosts: the residual goes back up.
    const over = waterfallSteps(summary, 0, { Equipe: 100, Aluguel: 80 });
    expect(over.find((s) => s.key === "other_costs")).toMatchObject({
      kind: "up",
      start: 820,
      end: 850,
    });
    expect(over.at(-1)?.end).toBe(850);

    // No other costs at all (otherCosts null) with no categories: no step.
    const none = waterfallSteps(summaryWith({ depositAmount: 10, cashResult: 10 }), 0, {});
    expect(none.some((s) => s.key === "other_costs")).toBe(false);
  });

  it("no residual step when categories add up within half a cent", () => {
    const summary = summaryWith({ depositAmount: 1000, otherCosts: 100.01, cashResult: 899.99 });
    const steps = waterfallSteps(summary, 0, { Equipe: 33.34, Aluguel: 66.67 });
    expect(steps.some((s) => s.key === "other_costs")).toBe(false);
    expect(steps.at(-1)?.end).toBe(899.99);
  });

  it("omits zero-amount down steps", () => {
    const summary = summaryWith({ depositAmount: 1000, withdrawalAmount: 0, cashResult: 1000 });
    const steps = waterfallSteps(summary, 0, { Equipe: 0 });
    expect(steps.some((s) => s.key === "withdrawals")).toBe(false);
    expect(steps.some((s) => s.key === "category:Equipe")).toBe(false);
  });
});
