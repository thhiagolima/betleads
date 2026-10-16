import { describe, expect, it } from "vitest";

import { aggregateCrmResults, compareHoldout, type CrmResultRow } from "./crm-results";

const row = (overrides: Partial<CrmResultRow>): CrmResultRow => ({
  metric_date: "2026-10-10",
  source_type: "journey",
  source_key: "j1",
  source_id: "j1",
  step_position: 0,
  player_state: "esfriando",
  sent: 0,
  failed: 0,
  cost: 0,
  recipients: 0,
  human_clicks: 0,
  direct_conversions: 0,
  direct_revenue: 0,
  influenced_players: 0,
  influenced_deposits: 0,
  influenced_revenue: 0,
  ...overrides,
});

const rows: CrmResultRow[] = [
  row({
    sent: 100,
    cost: 12,
    recipients: 100,
    influenced_players: 4,
    influenced_deposits: 5,
    influenced_revenue: 400,
  }),
  row({
    step_position: 2,
    sent: 50,
    cost: 6,
    recipients: 50,
    influenced_players: 1,
    influenced_revenue: 50,
  }),
  row({
    metric_date: "2026-10-11",
    source_type: "campaign",
    source_key: "Promo X",
    source_id: null,
    player_state: "ativo",
    sent: 1000,
    cost: 120,
    recipients: 1000,
    direct_conversions: 2,
    direct_revenue: 300,
  }),
];

describe("aggregateCrmResults", () => {
  const result = aggregateCrmResults(rows, { j1: "Esfriando 2d" });

  it("sums totals and keeps direct and influenced revenue apart", () => {
    expect(result.totals).toMatchObject({
      sent: 1150,
      cost: 138,
      influencedPlayers: 5,
      influencedRevenue: 450,
      directRevenue: 300,
      costOnActive: 120,
    });
    expect(result.totals.costPerRecovered).toBeCloseTo(27.6);
    expect(result.totals.roi).toBeCloseTo(450 / 138);
  });

  it("ranks origins by recovered revenue, with names and journey steps", () => {
    expect(result.sources.map((source) => source.name)).toEqual(["Esfriando 2d", "Promo X"]);
    const journey = result.sources[0];
    expect(journey.steps.map((step) => [step.position, step.sent])).toEqual([
      [0, 100],
      [2, 50],
    ]);
    expect(journey.costPerRecovered).toBeCloseTo(18 / 5);
    expect(result.sources[1]).toMatchObject({ costOnActive: 120, costPerRecovered: null, roi: 0 });
  });

  it("builds a daily series in date order", () => {
    expect(result.daily).toEqual([
      { date: "2026-10-10", cost: 18, influencedRevenue: 450, directRevenue: 0 },
      { date: "2026-10-11", cost: 120, influencedRevenue: 0, directRevenue: 300 },
    ]);
  });

  it("groups by player state with a recovery rate", () => {
    const cooling = result.states.find((state) => state.state === "esfriando");
    expect(cooling).toMatchObject({
      label: "Esfriando (2–7 dias)",
      recipients: 150,
      influencedPlayers: 5,
    });
    expect(cooling?.recoveryRate).toBeCloseTo(5 / 150);
  });

  it("handles an empty period", () => {
    const none = aggregateCrmResults([]);
    expect(none.totals).toMatchObject({ sent: 0, costPerRecovered: null, roi: null });
    expect(none.sources).toEqual([]);
  });
});

describe("compareHoldout (F3)", () => {
  it("computes lift, a 95% interval and incremental results", () => {
    const result = compareHoldout(
      { players: 1900, returned: 380, revenue: 38_000 },
      { players: 100, returned: 10, revenue: 800 },
    );
    expect(result.treatedRate).toBeCloseTo(0.2);
    expect(result.controlRate).toBeCloseTo(0.1);
    expect(result.lift).toBeCloseTo(0.1);
    expect(result.ciLow).toBeGreaterThan(0.03);
    expect(result.ciHigh).toBeLessThan(0.17);
    expect(result).toMatchObject({ sufficient: true, significant: true });
    expect(result.incrementalPlayers).toBeCloseTo(190);
    expect(result.incrementalRevenue).toBeCloseTo((20 - 8) * 1900);
  });

  it("does not call a small control group significant", () => {
    const result = compareHoldout(
      { players: 500, returned: 100, revenue: 0 },
      { players: 20, returned: 1, revenue: 0 },
    );
    expect(result).toMatchObject({ sufficient: false, significant: false });
  });

  it("is not significant when the interval crosses zero", () => {
    const result = compareHoldout(
      { players: 950, returned: 100, revenue: 0 },
      { players: 150, returned: 15, revenue: 0 },
    );
    expect(result.sufficient).toBe(true);
    expect(result.significant).toBe(false);
  });

  it("handles a journey without control players", () => {
    expect(
      compareHoldout(
        { players: 10, returned: 1, revenue: 0 },
        { players: 0, returned: 0, revenue: 0 },
      ),
    ).toMatchObject({
      controlRate: null,
      lift: null,
      sufficient: false,
    });
  });
});
