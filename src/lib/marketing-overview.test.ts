import { describe, expect, it } from "vitest";
import {
  addDays,
  brtPeriodRange,
  buildMarketingOverview,
  parseOverviewPeriod,
  periodDays,
  type MarketingOverviewRpc,
} from "./marketing-overview";

describe("AL1-02 períodos no calendário de Brasília", () => {
  // 19/10/2026 01:30 UTC = 18/10/2026 22:30 em Brasília.
  const lateNight = new Date("2026-10-19T01:30:00Z");

  it("depois das 21h, hoje continua sendo hoje em Brasília", () => {
    expect(brtPeriodRange("today", lateNight)).toEqual({
      from: "2026-10-18",
      to: "2026-10-18",
      days: 1,
    });
    expect(brtPeriodRange("yesterday", lateNight)).toMatchObject({
      from: "2026-10-17",
      to: "2026-10-17",
    });
  });

  it("presets de 7 e 30 dias contam as duas pontas", () => {
    expect(brtPeriodRange("7d", lateNight)).toEqual({
      from: "2026-10-12",
      to: "2026-10-18",
      days: 7,
    });
    expect(brtPeriodRange("30d", lateNight).days).toBe(30);
  });

  it("este mês e mês passado, inclusive na virada do ano", () => {
    expect(brtPeriodRange("this_month", lateNight)).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-18",
    });
    expect(brtPeriodRange("last_month", lateNight)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      days: 30,
    });
    const january = new Date("2027-01-10T12:00:00Z");
    expect(brtPeriodRange("last_month", january)).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
      days: 31,
    });
  });

  it("addDays e periodDays", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(periodDays("2026-10-01", "2026-10-01")).toBe(1);
  });
});

describe("parseOverviewPeriod", () => {
  it("aceita um período válido", () => {
    expect(parseOverviewPeriod("2026-10-01", "2026-10-07")).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
    });
  });

  it("recusa formato, data inexistente, ordem invertida e mais de um ano", () => {
    expect(() => parseOverviewPeriod("abc", "2026-10-07")).toThrow(/inválido/);
    expect(() => parseOverviewPeriod("2026-02-30", "2026-03-01")).toThrow(/inválido/);
    expect(() => parseOverviewPeriod("2026-10-07", "2026-10-01")).toThrow(/inválido/);
    expect(() => parseOverviewPeriod("2025-01-01", "2026-10-01")).toThrow(/1 ano/);
  });
});

describe("buildMarketingOverview", () => {
  const raw = {
    period: { from: "2026-10-01", to: "2026-10-07" },
    totals: {
      spend: "110.00",
      spendOther: [{ currency: "USD", spend: "5.00" }],
      impressions: 11500,
      clicks: 0,
      linkClicks: 0,
      players: 8,
      ftd: 4,
      paidPlayers: 4,
      paidFtd: 3,
      markedPlayers: 7,
      orphanPlayers: 2,
      revenue: "200",
      withdrawals: "30",
      net: "170",
      ftdRevenue: "150",
      redepositRevenue: "50",
      roas: "1.5455",
      roasGross: null,
      cpaFtd: "36.67",
      cacSignup: null,
    },
    attributionHealth: {
      total: 8,
      marked: 7,
      matched: 4,
      missingUtm: 1,
      crm: 1,
      ambiguous: 1,
      orphan: 1,
      pending: 0,
      matchRate: "66.67",
    },
    creatives: [
      { creative: "A", campaign: "C", revenue: "150", spend: "30", players: 2, ftd: 2, net: "120" },
      { creative: "B", campaign: "C", revenue: "50", spend: "20", players: 1, ftd: 1, net: "50" },
      { creative: "Z", campaign: null, revenue: 0, spend: "60", players: 0, ftd: 0, net: 0 },
    ],
    creativesOthers: { count: "13", spend: "0" },
    campaigns: [],
    campaignsOthers: { count: 0, spend: 0 },
    audiences: [],
    audiencesOthers: { count: 0, spend: 0 },
    orphanAttributions: [],
    daily: [{ date: "2026-10-01", label: "01/10", spend: "10", ftd: 0, signups: 1 }],
  } as unknown as MarketingOverviewRpc;

  it("converte numeric do Postgres em número e preserva nulos", () => {
    const o = buildMarketingOverview(raw);
    expect(o.totals.spend).toBe(110);
    expect(o.totals.spendOther).toEqual([{ currency: "USD", spend: 5 }]);
    expect(o.totals.roas).toBeCloseTo(1.5455, 4);
    expect(o.totals.roasGross).toBeNull();
    expect(o.totals.cacSignup).toBeNull();
    expect(o.attributionHealth.matchRate).toBeCloseTo(66.67, 2);
    expect(o.creativesOthers.count).toBe(13);
    expect(o.daily[0].spend).toBe(10);
  });

  it("o mapa de receita só tem quem depositou e soma 100%", () => {
    const o = buildMarketingOverview(raw);
    expect(o.moneyMap.map((row) => row.creative)).toEqual(["A", "B"]);
    expect(o.moneyMap.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(100, 6);
  });

  it("MB4-04: sem filtro o resultado traz filter null; com filtro, as contas", () => {
    expect(buildMarketingOverview(raw).filter).toBeNull();
    expect(buildMarketingOverview({ ...raw, filter: null }).filter).toBeNull();
    const filtered = buildMarketingOverview({
      ...raw,
      filter: { ad_account_ids: ["act_1", "act_2"], players_scope: "matched_only" },
    });
    expect(filtered.filter).toEqual({
      ad_account_ids: ["act_1", "act_2"],
      players_scope: "matched_only",
    });
  });
});
