import { describe, expect, it } from "vitest";
import {
  normalizeBrazilianPhone,
  normalizePlayerPhone,
  phoneWithCountryCode,
  requireBrazilianPhone,
} from "./phone-normalization";

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

describe("phoneWithCountryCode", () => {
  it("keeps Brazilian or DDI-less numbers as sent", () => {
    expect(phoneWithCountryCode("21964031645", "55", "5521964031645")).toBe("21964031645");
    expect(phoneWithCountryCode("21964031645", "", "")).toBe("21964031645");
    expect(phoneWithCountryCode(null, undefined, undefined)).toBeNull();
  });

  it("uses phone_e164 for a foreign DDI", () => {
    expect(phoneWithCountryCode("3483451193", "54", "543483451193")).toBe("+543483451193");
  });

  it("prefixes the DDI when phone_e164 is missing", () => {
    expect(phoneWithCountryCode("3483451193", "54", "")).toBe("+543483451193");
    expect(phoneWithCountryCode("+543483451193", 54, null)).toBe("+543483451193");
  });
});

describe("normalizePlayerPhone", () => {
  it("normalizes Brazilian numbers like before", () => {
    expect(normalizePlayerPhone("21964031645")).toBe("+5521964031645");
    expect(normalizePlayerPhone("+5521964031645")).toBe("+5521964031645");
  });

  it("keeps an explicit international number", () => {
    expect(normalizePlayerPhone("+543483451193")).toBe("+543483451193");
    expect(normalizeBrazilianPhone("+543483451193")).toBeNull();
  });

  it("never turns a bare foreign local number into +55 by accident", () => {
    expect(normalizePlayerPhone("3414489430")).toBeNull();
    expect(normalizePlayerPhone("+55123")).toBeNull();
  });
});
