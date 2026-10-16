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
  direct_players: 0,
  direct_revenue: 0,
  influenced_players: 0,
  influenced_deposits: 0,
  influenced_revenue: 0,
  ...overrides,
});

const journey = (key: string, overrides: Partial<CrmResultRow>) =>
  row({ source_key: key, source_id: key, ...overrides });

const results = aggregateCrmResults(
  [
    // Cheap, efficient journey with a dead step.
    journey("esf", { sent: 1500, cost: 30, human_clicks: 60, direct_players: 30 }),
    journey("esf", { step_position: 4, cost: 60 }),
    // Typical journeys.
    journey("dor", { sent: 1500, cost: 300, human_clicks: 50, direct_players: 10 }),
    journey("trinta", { sent: 1500, cost: 330, human_clicks: 55, direct_players: 10 }),
    // Expensive journey with a weak link.
    journey("caro", { sent: 1500, cost: 3000, human_clicks: 3, direct_players: 10 }),
    // Brings players back, but nobody converts through the link.
    journey("semlink", { cost: 80, influenced_players: 4 }),
    // Mass campaign to active players that converts nobody.
    row({
      source_type: "campaign",
      source_key: "Promo",
      source_id: null,
      step_position: -1,
      player_state: "ativo",
      cost: 1500,
    }),
  ],
  {
    esf: "Esfriando",
    dor: "Dormindo",
    trinta: "30 dias",
    caro: "Caro",
    semlink: "Sem link",
  },
);

describe("buildRecommendations", () => {
  const items = buildRecommendations(results);
  const titles = items.map((item) => item.title);

  it("flags a source that spends without any conversion, first", () => {
    expect(items[0].severity).toBe("acao");
    expect(items[0].title).toContain("Promo");
    expect(items[0].title).toContain("sem nenhuma conversão");
  });

  it("flags a source that brings players back but converts nobody through the link", () => {
    expect(titles).toContain("Sem link não converteu ninguém pelo link");
  });

  it("flags a dead journey step", () => {
    expect(titles).toContain("Etapa 5 de Esfriando não converteu ninguém");
  });

  it("flags spend on already active players", () => {
    expect(titles.some((title) => title.startsWith("100% do custo de Promo"))).toBe(true);
  });

  it("compares cost per converted player against the median", () => {
    expect(titles).toContain("Esfriando é a forma mais barata de converter");
    expect(titles).toContain("Caro converte, mas caro");
    expect(titles.some((title) => title.startsWith("Dormindo"))).toBe(false);
  });

  it("flags a click rate far below the median", () => {
    expect(titles).toContain("Pouca gente clica no link de Caro");
  });

  it("does not compare sources with fewer than 5 converted players", () => {
    const small = aggregateCrmResults([
      journey("a", { cost: 10, direct_players: 4 }),
      journey("b", { cost: 100, direct_players: 4 }),
      journey("c", { cost: 1000, direct_players: 4 }),
    ]);
    expect(buildRecommendations(small).some((item) => item.title.includes("converte"))).toBe(false);
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
