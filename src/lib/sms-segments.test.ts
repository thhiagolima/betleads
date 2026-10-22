import { describe, expect, it } from "vitest";
import { countSmsSegments } from "./sms-segments";

describe("countSmsSegments", () => {
  it.each([
    ["", "GSM-7", 0],
    ["a".repeat(160), "GSM-7", 1],
    ["a".repeat(161), "GSM-7", 2],
    ["a".repeat(306), "GSM-7", 2],
    ["a".repeat(307), "GSM-7", 3],
    ["{".repeat(80), "GSM-7", 1],      // extensão = 2 unidades → 160
    ["{".repeat(81), "GSM-7", 2],
    ["Ç".repeat(70), "GSM-7", 1],      // Ç (uppercase) está no GSM-7
    ["ç".repeat(70), "UCS-2", 1],      // ç (lowercase) NÃO está no GSM-7
    ["ã".repeat(70), "UCS-2", 1],
    ["ã".repeat(71), "UCS-2", 2],
    ["ã".repeat(134), "UCS-2", 2],
    ["ã".repeat(135), "UCS-2", 3],
    ["Oi 😀", "UCS-2", 1],             // emoji = 2 unidades UTF-16
  ])("%j → %s, %i segmento(s)", (text, encoding, segments) => {
    expect(countSmsSegments(text)).toMatchObject({ encoding, segments });
  });

  // Real-text test with non-GSM character (ô)
  it('real-text with accent: "Oi Maria, seu bônus de R$ 50 expira hoje 23:59" → UCS-2', () => {
    const result = countSmsSegments("Oi Maria, seu bônus de R$ 50 expira hoje 23:59");
    expect(result.encoding).toBe("UCS-2");
  });

  // Pure GSM text with a–z, A–Z, 0–9, and special chars
  it('pure GSM text: "Hello World 12345678 xyz BCDXY" → GSM-7, 1 segment', () => {
    const text = "Hello World 12345678 xyz BCDXY";
    const result = countSmsSegments(text);
    expect(result).toMatchObject({
      encoding: "GSM-7",
      units: text.length,
      segments: 1,
    });
  });

  // Extension character asserting units count as 2
  it('extension char units: "a{b" → units 4 (a=1, {=2, b=1)', () => {
    const result = countSmsSegments("a{b");
    expect(result).toMatchObject({
      encoding: "GSM-7",
      units: 4,
      segments: 1,
    });
  });

  // Test each character of GSM-7 basic alphabet (regression test)
  it("every basic GSM-7 character classifies as GSM-7", () => {
    const gsmBasic =
      "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    for (const char of gsmBasic) {
      const result = countSmsSegments(char);
      expect(result.encoding).toBe("GSM-7");
    }
  });

  // Test each character of GSM-7 extension alphabet
  it("every extension GSM-7 character classifies as GSM-7", () => {
    const gsmExtension = "^{}\\[~]|€\f";
    for (const char of gsmExtension) {
      const result = countSmsSegments(char);
      expect(result.encoding).toBe("GSM-7");
      expect(result.units).toBe(2); // extension chars are 2 units
    }
  });
});
