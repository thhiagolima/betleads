import { describe, expect, it } from "vitest";

import { aggregateCrmResults, type CrmResultRow } from "./crm-results";

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
