import { describe, expect, it } from "vitest";
import { isBlankMoneyValue, parseMoneyValue } from "./money-parse";

describe("parseMoneyValue", () => {
  it.each<[unknown, number]>([
    [10, 10],
    [10.5, 10.5],
    [-25, 25],
    [0, 0],
    ["10", 10],
    ["10.5", 10.5],
    ["10.50", 10.5],
    ["10,50", 10.5],
    ["0,99", 0.99],
    [",50", 0.5],
    ["R$ 10,50", 10.5],
    ["R$10,50", 10.5],
    ["R$ 10,50", 10.5],
    ["$ 10.50", 10.5],
    ["10,50 BRL", 10.5],
    ["BRL 10.50", 10.5],
    ["ARS 1.500", 1500],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1.234.567,89", 1234567.89],
    ["1,234,567.89", 1234567.89],
    ["1 234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    // Single separator + exactly 3 digits after it: thousands.
    ["1.234", 1234],
    ["1,234", 1234],
    ["12.500", 12500],
    ["999,000", 999000],
    // ...unless the integer part starts with 0 or has more than 3 digits.
    ["0.500", 0.5],
    ["0,125", 0.125],
    ["1234.567", 1234.567],
    ["-10,50", 10.5],
    ["-R$ 10,50", 10.5],
    ["R$ -10,50", 10.5],
    ["  42.00  ", 42],
  ])("parses %j as %d", (raw, expected) => {
    expect(parseMoneyValue(raw)).toBeCloseTo(expected, 10);
  });

  it.each<unknown>([
    null,
    undefined,
    "",
    "   ",
    "abc",
    "R$",
    "R$ ,",
    "1e5",
    "10abc5",
    "1,2,3",
    "1.234.56",
    "1.23.456",
    "1,234,56",
    "1.234,567.89",
    "1,234.567,89",
    "--10",
    "-R$ -10",
    "10-",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    {},
    { value: 10 },
    [10],
  ])("rejects %j", (raw) => {
    expect(parseMoneyValue(raw)).toBeNull();
  });
});

describe("isBlankMoneyValue", () => {
  it("treats null, undefined and blank strings as absent", () => {
    expect(isBlankMoneyValue(null)).toBe(true);
    expect(isBlankMoneyValue(undefined)).toBe(true);
    expect(isBlankMoneyValue("  ")).toBe(true);
    expect(isBlankMoneyValue("0")).toBe(false);
    expect(isBlankMoneyValue(0)).toBe(false);
  });
});
