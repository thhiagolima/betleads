import { describe, expect, it } from "vitest";

import { maskPayerDocument } from "./payer";

describe("maskPayerDocument", () => {
  it("masks an 11-digit CPF, keeping only digits 4-9 visible", () => {
    expect(maskPayerDocument("123.456.789-09")).toBe("***.456.789-**");
  });

  it("masks a 14-digit CNPJ, keeping only digits 3-8 visible", () => {
    expect(maskPayerDocument("12345678000199")).toBe("**.345.678/****-**");
  });

  it("masks any other digit count fully", () => {
    expect(maskPayerDocument("123")).toBe("***");
  });

  it("returns null for null", () => {
    expect(maskPayerDocument(null)).toBeNull();
  });

  it("strips non-digit characters before counting (plain digits, no punctuation)", () => {
    expect(maskPayerDocument("12345678909")).toBe("***.456.789-**");
  });

  it("masks an empty string fully", () => {
    expect(maskPayerDocument("")).toBe("***");
  });
});
