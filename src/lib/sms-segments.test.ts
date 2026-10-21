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
    ["ç".repeat(70), "GSM-7", 1],      // ç está no GSM-7 básico
    ["ã".repeat(70), "UCS-2", 1],
    ["ã".repeat(71), "UCS-2", 2],
    ["ã".repeat(134), "UCS-2", 2],
    ["ã".repeat(135), "UCS-2", 3],
    ["Oi 😀", "UCS-2", 1],             // emoji = 2 unidades UTF-16
  ])("%j → %s, %i segmento(s)", (text, encoding, segments) => {
    expect(countSmsSegments(text)).toMatchObject({ encoding, segments });
  });
});
