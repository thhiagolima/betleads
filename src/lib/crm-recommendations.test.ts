import { describe, expect, it } from "vitest";

import { buildRecommendations } from "./crm-recommendations";
import { aggregateCrmResults, compareHoldout, type CrmResultRow } from "./crm-results";

const row = (overrides: Partial<CrmResultRow>): CrmResultRow => ({
  metric_date: "2026-10-10",
  source_type: "journey",
  source_key: "j",
  source_id: "j",
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

const results = aggregateCrmResults(
  [
    // Cheap, efficient journey with a dead step.
    row({
      source_key: "esf",
      source_id: "esf",
      cost: 30,
      influenced_players: 30,
      influenced_revenue: 900,
    }),
    row({ source_key: "esf", source_id: "esf", step_position: 4, cost: 60 }),
    // Typical journeys.
    row({ source_key: "dor", source_id: "dor", cost: 300, influenced_players: 10 }),
    row({ source_key: "trinta", source_id: "trinta", cost: 330, influenced_players: 10 }),
    // Expensive journey.
    row({ source_key: "caro", source_id: "caro", cost: 3000, influenced_players: 10 }),
    // Mass campaign to active players that recovers nobody.
    row({
      source_type: "campaign",
      source_key: "Promo",
      source_id: null,
      player_state: "ativo",
      cost: 1500,
    }),
  ],
  { esf: "Esfriando", dor: "Dormindo", trinta: "30 dias", caro: "Caro" },
);

describe("buildRecommendations", () => {
  const items = buildRecommendations(results);
  const titles = items.map((item) => item.title);

  it("flags a source that spends without recovering anyone, first", () => {
    expect(items[0].severity).toBe("acao");
    expect(items[0].title).toContain("Promo");
    expect(items[0].title).toContain("sem recuperar ninguém");
  });

  it("flags a dead journey step", () => {
    expect(titles).toContain("Etapa 5 de Esfriando não recuperou ninguém");
  });

  it("flags spend on already active players", () => {
    expect(titles.some((title) => title.startsWith("100% do custo de Promo"))).toBe(true);
  });

  it("points out the most efficient and the expensive sources against the median", () => {
    expect(titles).toContain("Esfriando é a forma mais barata de recuperar jogadores");
    expect(titles).toContain("Caro recupera, mas caro");
    expect(titles.some((title) => title.startsWith("Dormindo"))).toBe(false);
  });

  it("reads holdout results", () => {
    const worse = {
      name: "J1",
      ...compareHoldout(
        { players: 2000, returned: 100, revenue: 0 },
        { players: 200, returned: 30, revenue: 0 },
      ),
    };
    const better = {
      name: "J2",
      ...compareHoldout(
        { players: 2000, returned: 400, revenue: 0 },
        { players: 200, returned: 10, revenue: 0 },
      ),
    };
    const small = {
      name: "J3",
      ...compareHoldout(
        { players: 50, returned: 5, revenue: 0 },
        { players: 5, returned: 0, revenue: 0 },
      ),
    };
    const holdoutItems = buildRecommendations({ sources: [] }, [worse, better, small]);
    expect(holdoutItems.map((item) => [item.severity, item.title])).toEqual([
      ["acao", "J1 está pior que não enviar"],
      ["oportunidade", "J2 tem efeito comprovado"],
    ]);
  });

  it("says nothing without data", () => {
    expect(buildRecommendations({ sources: [] })).toEqual([]);
  });
});
