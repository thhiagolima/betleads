import { describe, expect, it } from "vitest";

import { currencySymbol, formatMoney, toTenantCurrency } from "./currency";

// ICU separa símbolo e número com espaço não separável (U+00A0).
const NBSP = String.fromCharCode(160);
function plain(s: string) {
  return s.split(NBSP).join(" ");
}

describe("formatMoney", () => {
  it("defaults to BRL in the Brazilian format", () => {
    expect(plain(formatMoney(10137.9))).toBe("R$ 10.137,90");
    expect(plain(formatMoney(null))).toBe("R$ 0,00");
  });

  it("formats ARS the conventional Argentine way", () => {
    expect(plain(formatMoney(10000, "ARS"))).toBe("$ 10.000,00");
    expect(plain(formatMoney(-5, "ARS"))).toBe("-$ 5,00");
  });

  it("falls back to BRL for unknown or missing currencies", () => {
    expect(plain(formatMoney(1, "XYZ"))).toBe("R$ 1,00");
    expect(plain(formatMoney(1, null))).toBe("R$ 1,00");
  });

  it("honours fixed decimals", () => {
    expect(plain(formatMoney(1234.56, "ARS", { decimals: 0 }))).toBe("$ 1.235");
  });
});

describe("toTenantCurrency", () => {
  it("normalizes case and rejects unknown codes", () => {
    expect(toTenantCurrency("ars")).toBe("ARS");
    expect(toTenantCurrency("EUR")).toBe("BRL");
    expect(toTenantCurrency(undefined)).toBe("BRL");
  });
});

describe("currencySymbol", () => {
  it("returns the local symbol", () => {
    expect(currencySymbol("BRL")).toBe("R$");
    expect(currencySymbol("ARS")).toBe("$");
    expect(currencySymbol("PEN")).toBe("S/");
  });
});
