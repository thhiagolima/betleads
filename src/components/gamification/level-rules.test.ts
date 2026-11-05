import { describe, expect, it } from "vitest";

import { levelRange } from "./level-rules";

const nbsp = (s: string) => s.replaceAll(String.fromCharCode(160), " ");
const thresholds = { bronze: 10, silver: 200, gold: 1000, diamond: 5000, black: 10000 };

describe("levelRange", () => {
  it("mostra as faixas em BRL por padrão", () => {
    expect(nbsp(levelRange("novice", thresholds))).toBe("abaixo de R$ 10");
    expect(nbsp(levelRange("gold", thresholds))).toBe("R$ 1.000 a R$ 5.000");
    expect(nbsp(levelRange("black", thresholds))).toBe("R$ 10.000 ou mais");
  });

  it("usa a moeda da casa", () => {
    expect(nbsp(levelRange("gold", thresholds, "ARS"))).toBe("$ 1.000 a $ 5.000");
    expect(nbsp(levelRange("bronze", { ...thresholds, bronze: 12.5 }, "ARS"))).toBe(
      "$ 12,50 a $ 200",
    );
  });
});
