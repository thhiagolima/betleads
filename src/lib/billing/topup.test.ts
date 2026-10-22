import { describe, expect, it } from "vitest";

import {
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  resolveTopupAmount,
  topupDescription,
} from "./topup";

describe("resolveTopupAmount", () => {
  it("resolves a known package by code", () => {
    expect(resolveTopupAmount({ packageCode: "p1000" })).toEqual({
      amountCents: 100000,
      packageCode: "p1000",
    });
  });

  it("accepts a free amount at the minimum", () => {
    expect(resolveTopupAmount({ amountCents: MIN_TOPUP_CENTS })).toEqual({
      amountCents: MIN_TOPUP_CENTS,
      packageCode: null,
    });
  });

  it("rejects a free amount below the minimum", () => {
    expect(() => resolveTopupAmount({ amountCents: 9999 })).toThrow(
      "Valor mínimo de compra: R$ 100,00",
    );
  });

  it("rejects a free amount above the maximum", () => {
    expect(() => resolveTopupAmount({ amountCents: MAX_TOPUP_CENTS + 1 })).toThrow(
      "Valor máximo de compra: R$ 50.000,00",
    );
  });

  it("rejects an unknown package code", () => {
    expect(() => resolveTopupAmount({ packageCode: "does-not-exist" })).toThrow(
      "Pacote inválido",
    );
  });
});

describe("topupDescription", () => {
  it("formats the house name, label and BRL amount", () => {
    expect(topupDescription("Sorte Alta", 100000)).toBe(
      "Sorte Alta - Créditos BetLeads R$ 1.000,00",
    );
  });

  it("truncates a long house name so the description stays at 140 chars", () => {
    const longName = "A".repeat(200);
    const description = topupDescription(longName, 100000);
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description.endsWith(" - Créditos BetLeads R$ 1.000,00")).toBe(true);
  });
});
