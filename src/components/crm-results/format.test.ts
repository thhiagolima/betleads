import { describe, expect, it } from "vitest";

import {
  compareLabel,
  cost,
  crossCurrencyNote,
  deltaView,
  isCrossCurrency,
  money,
  perReal,
} from "./format";

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

  it("shows the return in reais and labels one day with its weekday", () => {
    expect(plain(perReal(7.9))).toBe("R$ 7,90");
    expect(compareLabel("2026-11-01", "2026-11-01")).toBe("dom 01/11");
    expect(compareLabel("2026-10-25", "2026-10-31")).toBe("25/10 a 31/10");
  });
});

describe("deltaView", () => {
  const formatDiff = (value: number) => String(value);

  it("shows the absolute difference in grey when the sample is small", () => {
    expect(deltaView({ current: 2197, previous: 3600, comparable: false, formatDiff })).toEqual({
      text: "−1403",
      tone: "muted",
    });
    expect(deltaView({ current: 5, previous: 5, comparable: false, formatDiff })).toEqual({
      text: "igual",
      tone: "muted",
    });
  });

  it("colours percent changes by direction, and never neutral metrics", () => {
    expect(deltaView({ current: 90, previous: 100, comparable: true, formatDiff })).toEqual({
      text: "▼ 10%",
      tone: "danger",
    });
    expect(
      deltaView({ current: 90, previous: 100, better: "low", comparable: true, formatDiff }),
    ).toEqual({ text: "▼ 10%", tone: "success" });
    expect(
      deltaView({ current: 8, previous: 100, neutral: true, comparable: true, formatDiff }),
    ).toEqual({ text: "▼ 92%", tone: "muted" });
  });

  it("caps big increases as a multiple of the previous value", () => {
    expect(deltaView({ current: 7.9, previous: 1, comparable: true, formatDiff })?.text).toBe(
      "▲ 7,9x",
    );
  });

  it("returns nothing without a previous value", () => {
    expect(deltaView({ current: 1, previous: null, comparable: true, formatDiff })).toBeNull();
  });
});
