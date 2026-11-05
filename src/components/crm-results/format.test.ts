import { describe, expect, it } from "vitest";

import { cost, crossCurrencyNote, isCrossCurrency, money } from "./format";

// Intl usa espaço não separável entre símbolo e valor; normaliza para comparar.
const plain = (value: string) => value.split(String.fromCharCode(160)).join(" ");

describe("crm-results format", () => {
  it("formats house values in the house currency and costs always in BRL", () => {
    expect(plain(money(10000, "ARS"))).toBe("$ 10.000,00");
    expect(plain(money(1234.5, "BRL"))).toBe("R$ 1.234,50");
    expect(plain(cost(12.3))).toBe("R$ 12,30");
  });

  it("shows a dash for missing values", () => {
    expect(money(null, "ARS")).toBe("—");
    expect(cost(null)).toBe("—");
  });

  it("flags revenue vs BRL cost ratios outside BRL", () => {
    expect(isCrossCurrency("BRL")).toBe(false);
    expect(isCrossCurrency("ARS")).toBe(true);
    // Valor desconhecido cai em BRL, como no resto do sistema.
    expect(isCrossCurrency("")).toBe(false);
    expect(crossCurrencyNote("ARS")).toBe("Receita em ARS e custo em BRL: sem conversão de câmbio");
  });
});
