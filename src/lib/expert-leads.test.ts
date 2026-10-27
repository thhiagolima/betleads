import { describe, expect, it } from "vitest";

import { diasSemDepositar } from "./expert-leads";

describe("diasSemDepositar", () => {
  it("retorna null sem depósito", () => {
    expect(diasSemDepositar(null, new Date())).toBeNull();
  });

  it("3 dias e 5 horas atrás -> 3", () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    const ultimoDeposito = new Date(now.getTime() - (3 * 24 + 5) * 3600 * 1000).toISOString();
    expect(diasSemDepositar(ultimoDeposito, now)).toBe(3);
  });

  it("depósito no mesmo dia -> 0", () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    const ultimoDeposito = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
    expect(diasSemDepositar(ultimoDeposito, now)).toBe(0);
  });
});
