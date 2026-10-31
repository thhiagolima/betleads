import { describe, expect, it } from "vitest";

import { formatBrlInput, parseBrlInput } from "./brl-input";

describe("parseBrlInput", () => {
  it.each([
    ["1.500,00", 1500],
    ["1.500", 1500],
    ["1500", 1500],
    ["1500,5", 1500.5],
    ["1500.50", 1500.5],
    ["R$ 1.234.567,89", 1234567.89],
    ["0", 0],
    ["0,00", 0],
    [" 250,", 250],
  ])("parses %s as %d", (raw, expected) => {
    expect(parseBrlInput(raw)).toBe(expected);
  });

  it("returns null for an empty field", () => {
    expect(parseBrlInput("")).toBeNull();
    expect(parseBrlInput("  R$ ")).toBeNull();
  });

  it.each(["abc", "-10", "1,2,3", "1.50,00", "10,123", "1.5.0"])("rejects %s", (raw) => {
    expect(parseBrlInput(raw)).toBeNaN();
  });
});

describe("formatBrlInput", () => {
  it("formats in pt-BR with two decimals", () => {
    expect(formatBrlInput(1500)).toBe("1.500,00");
    expect(formatBrlInput(0)).toBe("0,00");
    expect(formatBrlInput(null)).toBe("");
  });

  it("round-trips through parseBrlInput", () => {
    expect(parseBrlInput(formatBrlInput(98765.4))).toBe(98765.4);
  });
});
