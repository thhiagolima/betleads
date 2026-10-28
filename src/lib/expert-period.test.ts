import { describe, expect, it } from "vitest";

import { DEFAULT_EXPERT_PERIOD, periodRange } from "./expert-period";

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

  it("default period is 30 days", () => {
    expect(DEFAULT_EXPERT_PERIOD).toBe("30");
  });
});
