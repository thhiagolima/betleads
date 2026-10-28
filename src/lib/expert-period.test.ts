import { describe, expect, it } from "vitest";

import {
  comparisonRange,
  DEFAULT_EXPERT_PERIOD,
  DEFAULT_REPORT_PERIOD,
  EXPERT_PERIODS,
  periodRange,
  variationPct,
} from "./expert-period";

describe("periodRange", () => {
  it("hoje starts at 00:00 São Paulo", () => {
    const now = new Date("2026-10-24T18:30:00Z"); // 15:30 em São Paulo, dia 24
    const { from, to } = periodRange("hoje", now);

    expect(from).toBe("2026-10-24T03:00:00.000Z"); // 00:00 BRT = 03:00 UTC
    expect(to).toBe(now.toISOString());
  });

  it("30 days includes today", () => {
    const now = new Date("2026-10-24T18:30:00Z");
    const { from, to } = periodRange("30", now);

    // 29 dias antes do início de hoje (inclui hoje = 30 dias no total).
    expect(from).toBe("2026-09-25T03:00:00.000Z");
    expect(to).toBe(now.toISOString());
  });

  it("ontem is the full previous São Paulo day", () => {
    const now = new Date("2026-10-24T02:00:00Z"); // 23:00 de 23/10 em São Paulo
    const { from, to } = periodRange("ontem", now);

    // Em São Paulo "agora" ainda é dia 23, então ontem é o dia 22 inteiro.
    expect(from).toBe("2026-10-22T03:00:00.000Z");
    expect(to).toBe("2026-10-23T03:00:00.000Z");
  });

  it("mes_atual and mes_anterior at Oct 31 23:30 São Paulo (already Nov 1 in UTC)", () => {
    const now = new Date("2026-11-01T02:30:00Z"); // 23:30 de 31/10 em São Paulo

    expect(periodRange("mes_atual", now)).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      to: now.toISOString(),
    });
    expect(periodRange("mes_anterior", now)).toEqual({
      from: "2026-09-01T03:00:00.000Z",
      to: "2026-10-01T03:00:00.000Z",
    });
  });

  it("mes_atual and mes_anterior at Nov 1 00:10 São Paulo", () => {
    const now = new Date("2026-11-01T03:10:00Z"); // 00:10 de 01/11 em São Paulo

    expect(periodRange("mes_atual", now)).toEqual({
      from: "2026-11-01T03:00:00.000Z",
      to: now.toISOString(),
    });
    expect(periodRange("mes_anterior", now)).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      to: "2026-11-01T03:00:00.000Z",
    });
  });

  it("mes_anterior in January is the whole December of the previous year", () => {
    const now = new Date("2027-01-15T12:00:00Z");
    expect(periodRange("mes_anterior", now)).toEqual({
      from: "2026-12-01T03:00:00.000Z",
      to: "2027-01-01T03:00:00.000Z",
    });
  });

  it("expert pickers list the Central presets plus the calendar months", () => {
    expect(EXPERT_PERIODS.map((p) => p.label)).toEqual([
      "Hoje",
      "Ontem",
      "7 dias",
      "30 dias",
      "90 dias",
      "Este mês",
      "Mês passado",
    ]);
  });

  it("default period is 30 days", () => {
    expect(DEFAULT_EXPERT_PERIOD).toBe("30");
  });
});

describe("comparisonRange", () => {
  it("default report period is 'mes_atual'", () => {
    expect(DEFAULT_REPORT_PERIOD).toBe("mes_atual");
  });

  it("hoje compares with yesterday up to the same time", () => {
    const now = new Date("2026-10-28T17:00:00Z"); // 14:00 em São Paulo
    const { current, previous } = comparisonRange("hoje", now);

    expect(current).toEqual(periodRange("hoje", now));
    expect(previous).toEqual({
      from: "2026-10-27T03:00:00.000Z",
      to: "2026-10-27T17:00:00.000Z",
    });
  });

  it("ontem compares with the day before", () => {
    const now = new Date("2026-10-24T02:00:00Z"); // 23:00 de 23/10 em São Paulo
    const { current, previous } = comparisonRange("ontem", now);

    expect(current).toEqual(periodRange("ontem", now));
    expect(previous).toEqual({
      from: "2026-10-21T03:00:00.000Z",
      to: "2026-10-22T03:00:00.000Z",
    });
  });

  it("7/30/90 shift back by N days keeping the partial today", () => {
    const now = new Date("2026-10-24T18:30:00Z");

    expect(comparisonRange("30", now)).toEqual({
      current: { from: "2026-09-25T03:00:00.000Z", to: now.toISOString() },
      previous: { from: "2026-08-26T03:00:00.000Z", to: "2026-09-24T18:30:00.000Z" },
    });
  });

  it("mes_atual on Oct 31 compares with Sep 1..Sep 30 end", () => {
    const now = new Date("2026-10-31T15:00:00Z"); // 12:00 em São Paulo

    const { current, previous } = comparisonRange("mes_atual", now);

    expect(current).toEqual(periodRange("mes_atual", now));
    expect(previous).toEqual({
      from: "2026-09-01T03:00:00.000Z",
      to: "2026-10-01T03:00:00.000Z", // mês anterior mais curto: vai até o fim dele
    });
  });

  it("mes_anterior in January compares with the previous December", () => {
    const now = new Date("2027-01-15T15:00:00Z");

    const { current, previous } = comparisonRange("mes_anterior", now);

    expect(current).toEqual({
      from: "2026-12-01T03:00:00.000Z",
      to: "2027-01-01T03:00:00.000Z",
    });
    expect(previous).toEqual({
      from: "2026-11-01T03:00:00.000Z",
      to: "2026-12-01T03:00:00.000Z",
    });
  });
});

describe("variationPct", () => {
  it("is null without a previous base and rounds to 1 decimal", () => {
    expect(variationPct(100, 0)).toBeNull();
    expect(variationPct(150, 100)).toBe(50);
    expect(variationPct(133, 100)).toBe(33);
    expect(variationPct(133.33, 100)).toBe(33.3);
    expect(variationPct(50, 100)).toBe(-50);
  });
});
