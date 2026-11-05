import { describe, expect, it } from "vitest";

import { formatMoney } from "@/lib/currency";
import {
  HEALTH_THRESHOLDS,
  healthWindows,
  summarizeHouse,
  sortHouses,
  type HealthWindows,
  type HouseDay,
  type HouseHealthRow,
} from "./house-health";

function addDays(s: string, delta: number): string {
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

type WeekTotals = { registrations: number; ftds: number; recovered: number };

const ZERO_WEEK: WeekTotals = { registrations: 0, ftds: 0, recovered: 0 };

/** Spreads a week's total evenly across 7 days starting at `from`. */
function spreadWeek(from: string, totals: WeekTotals): HouseDay[] {
  return Array.from({ length: 7 }, (_, i) => ({
    date: addDays(from, i),
    registrations: totals.registrations / 7,
    ftds: totals.ftds / 7,
    recovered: totals.recovered / 7,
  }));
}

/** Builds the 35 days (4 base weeks + the current week) for `summarizeHouse`. */
function buildDays(
  windows: HealthWindows,
  baseWeeks: WeekTotals[],
  currentWeek: WeekTotals,
): HouseDay[] {
  const baseDays = baseWeeks.flatMap((week, i) =>
    spreadWeek(addDays(windows.base.from, i * 7), week),
  );
  const currentDays = spreadWeek(windows.current.from, currentWeek);
  return [...baseDays, ...currentDays];
}

const WINDOWS = healthWindows("2026-11-05");

function makeInput(
  baseWeeks: WeekTotals[],
  currentWeek: WeekTotals,
  moeda = "BRL",
): { tenantId: string; name: string; moeda: string; days: HouseDay[] } {
  return {
    tenantId: "tenant-1",
    name: "Casa Teste",
    moeda,
    days: buildDays(WINDOWS, baseWeeks, currentWeek),
  };
}

describe("healthWindows", () => {
  it("computes the current (last closed week) and base (4 weeks before it) windows", () => {
    expect(healthWindows("2026-11-05")).toEqual({
      current: { from: "2026-10-29", to: "2026-11-04" },
      base: { from: "2026-10-01", to: "2026-10-28" },
    });
  });
});

describe("summarizeHouse", () => {
  it("flags a red house on a registrations/FTDs crash (ForrandoBet-like)", () => {
    const input = makeInput(Array(4).fill({ registrations: 636, ftds: 218, recovered: 0 }), {
      registrations: 107,
      ftds: 57,
      recovered: 0,
    });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row).not.toBeNull();
    expect(row.level).toBe("red");
    const expectedRegPct = ((107 - 636) / 636) * 100;
    expect(row.deltas.registrationsPct).toBeCloseTo(expectedRegPct, 5);
    expect(row.reason).toBe("Cadastros −83% (107 vs ~636/semana)");
  });

  it("flags a red house on a conversion drop, reason leads with Conversão", () => {
    const input = makeInput(Array(4).fill({ registrations: 430, ftds: 278, recovered: 0 }), {
      registrations: 1614,
      ftds: 846,
      recovered: 0,
    });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    const baseConv = (278 / 430) * 100;
    const currentConv = (846 / 1614) * 100;
    const expectedPts = currentConv - baseConv;

    expect(row.level).toBe("red");
    expect(row.deltas.conversionPts).toBeCloseTo(expectedPts, 5);
    expect(row.reason).toMatch(/^Conversão −12 pts/);
    expect(row.reason).toContain("52,4%");
    expect(row.reason).toContain("64,7%");
  });

  it("flags yellow on a -30% registrations drop", () => {
    const input = makeInput(Array(4).fill({ registrations: 100, ftds: 0, recovered: 0 }), {
      registrations: 70,
      ftds: 0,
      recovered: 0,
    });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("yellow");
  });

  it("stays green when the base volume is below the minimum (Review Focus 1)", () => {
    const input = makeInput(Array(4).fill({ registrations: 10, ftds: 0, recovered: 0 }), {
      registrations: 1,
      ftds: 0,
      recovered: 0,
    });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("green");
    expect(row.reason).toBeNull();
  });

  it("flags no_history for a new house whose history starts in the newest base week (Review Focus 2)", () => {
    const baseWeeks: WeekTotals[] = [
      ZERO_WEEK,
      ZERO_WEEK,
      ZERO_WEEK,
      { registrations: 100, ftds: 50, recovered: 0 },
    ];
    const input = makeInput(baseWeeks, { registrations: 196, ftds: 90, recovered: 0 });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("no_history");
    expect(row.deltas.registrationsPct).toBeNull();
  });

  it("flags no_history when history starts in the 3rd base week (only 2 weeks since the first active one)", () => {
    const active = { registrations: 400, ftds: 100, recovered: 0 };
    const input = makeInput([ZERO_WEEK, ZERO_WEEK, active, active], active);
    expect((summarizeHouse(input, WINDOWS) as HouseHealthRow).level).toBe("no_history");
  });

  it("a house active in the 2 oldest base weeks and dead since is red, not no_history", () => {
    const active = { registrations: 400, ftds: 100, recovered: 0 };
    const input = makeInput([active, active, ZERO_WEEK, ZERO_WEEK], ZERO_WEEK);
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("red");
    expect(row.deltas.registrationsPct).toBe(-100);
    expect(row.reason).toContain("−100%");
  });

  it("with recoveryUnavailable, recovery is ignored: null delta, no recovery rule", () => {
    const baseWeeks = Array(4).fill({ registrations: 50, ftds: 20, recovered: 10000 });
    const input = makeInput(baseWeeks, { registrations: 50, ftds: 20, recovered: 0 });
    const row = summarizeHouse(input, WINDOWS, { recoveryUnavailable: true }) as HouseHealthRow;

    expect(row.level).toBe("green");
    expect(row.reason).toBeNull();
    expect(row.deltas.recoveredPct).toBeNull();
  });

  it("returns null for a house with no movement at all", () => {
    const input = makeInput(Array(4).fill(ZERO_WEEK), ZERO_WEEK);
    const row = summarizeHouse(input, WINDOWS);

    expect(row).toBeNull();
  });

  it("flags red on a recovered-amount crash, reason formatted in the house's moeda (Review Focus 3)", () => {
    const baseWeeks = Array(4).fill({ registrations: 50, ftds: 20, recovered: 10000 });
    const input = makeInput(baseWeeks, { registrations: 50, ftds: 20, recovered: 4000 }, "ARS");
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("red");
    expect(row.reason).toContain("Recuperação −60%");
    const expectedCurrent = formatMoney(4000, "ARS", { decimals: 0 });
    const expectedBase = formatMoney(10000, "ARS", { decimals: 0 });
    expect(row.reason).toBe(`Recuperação −60% (${expectedCurrent} vs ~${expectedBase}/semana)`);
  });

  it("picks the worst rule when metrics disagree (yellow registrations vs red FTDs)", () => {
    const input = makeInput(Array(4).fill({ registrations: 100, ftds: 50, recovered: 0 }), {
      registrations: 70, // -30%, yellow
      ftds: 20, // -60%, red
      recovered: 0,
    });
    const row = summarizeHouse(input, WINDOWS) as HouseHealthRow;

    expect(row.level).toBe("red");
    expect(row.reason).toMatch(/^FTDs/);
  });
});

describe("HEALTH_THRESHOLDS", () => {
  it("matches the spec's exact values", () => {
    expect(HEALTH_THRESHOLDS).toEqual({
      redPct: -50,
      yellowPct: -25,
      redConvPts: -10,
      yellowConvPts: -5,
      minBaseRegistrations: 20,
      minBaseFtds: 10,
      minBaseRecovered: 500,
      minHistoryWeeks: 3,
    });
  });
});

describe("sortHouses", () => {
  function row(level: HouseHealthRow["level"], worstValue: number | null): HouseHealthRow {
    return {
      tenantId: `t-${level}-${worstValue}`,
      name: "x",
      moeda: "BRL",
      level,
      reason: worstValue === null ? null : "x",
      current: { registrations: 0, ftds: 0, recovered: 0, conversion: null },
      base: { registrations: 0, ftds: 0, recovered: 0, conversion: null },
      deltas: {
        registrationsPct: worstValue,
        ftdsPct: null,
        conversionPts: null,
        recoveredPct: null,
      },
      worstDelta: worstValue,
    };
  }

  it("orders red, yellow, green, no_history; within a group the worst drop first", () => {
    const redWorse = row("red", -90);
    const redLess = row("red", -55);
    const yellow = row("yellow", -30);
    const green = row("green", null);
    const noHistory = row("no_history", null);

    const sorted = sortHouses([green, noHistory, yellow, redLess, redWorse]);

    expect(sorted).toEqual([redWorse, redLess, yellow, green, noHistory]);
  });

  it("ranks by the delta of metrics that passed their volume gate, not a gated-out one (fix round 1)", () => {
    // House A: only registrations counts (base 100/week, -70%, red) — no other
    // metric has enough base volume to be evaluated.
    const houseA = summarizeHouse(
      makeInput(Array(4).fill({ registrations: 100, ftds: 0, recovered: 0 }), {
        registrations: 30,
        ftds: 0,
        recovered: 0,
      }),
      WINDOWS,
    ) as HouseHealthRow;

    // House B: registrations counts too (base 100/week, -55%, red — a smaller
    // drop than House A's). It also has a recovered crash (-99%), but its base
    // (100/week) is below minBaseRecovered (500), so that metric is gated out
    // and must NOT be used for ranking, even though -99 is far worse than
    // anything in House A.
    const houseB = summarizeHouse(
      makeInput(Array(4).fill({ registrations: 100, ftds: 0, recovered: 100 }), {
        registrations: 45,
        ftds: 0,
        recovered: 1,
      }),
      WINDOWS,
    ) as HouseHealthRow;

    expect(houseA.level).toBe("red");
    expect(houseB.level).toBe("red");
    expect(houseA.worstDelta).toBeCloseTo(-70, 5);
    expect(houseB.worstDelta).toBeCloseTo(-55, 5);
    // The gated-out metric is still reported in `deltas` for the UI...
    expect(houseB.deltas.recoveredPct).toBeLessThan(-90);
    // ...but sortHouses must not rank House B ahead of House A because of it.
    expect(sortHouses([houseB, houseA])).toEqual([houseA, houseB]);
  });
});
