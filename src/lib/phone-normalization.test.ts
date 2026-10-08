import { describe, expect, it } from "vitest";
import { normalizeBrazilianPhone, requireBrazilianPhone } from "./phone-normalization";

describe("Brazilian phone normalization", () => {
  it.each([
    ["5521999998888", "+5521999998888"], ["+5521999998888", "+5521999998888"],
    ["21999998888", "+5521999998888"], ["(21) 99999-8888", "+5521999998888"],
    ["552133334444", "+552133334444"], ["21 3333-4444", "+552133334444"],
    ["55999998888", "+5555999998888"],
  ])("normalizes %s", (input, expected) => expect(normalizeBrazilianPhone(input)).toBe(expected));

  it("does not guess incomplete or malformed numbers", () => {
    expect(normalizeBrazilianPhone("9999-8888")).toBeNull();
    expect(normalizeBrazilianPhone("21123456789")).toBeNull();
    expect(() => requireBrazilianPhone("123")).toThrow(/inválido/i);
  });
});
