import { describe, expect, it } from "vitest";

import { DEFAULT_LEVEL_THRESHOLDS, levelForTotal, thresholdsFromSettingsRow } from "./player-level";

describe("levelForTotal", () => {
  it("usa as faixas padrão quando nada foi configurado", () => {
    expect(levelForTotal(0)).toBe("novice");
    expect(levelForTotal(9.99)).toBe("novice");
    expect(levelForTotal(10)).toBe("bronze");
    expect(levelForTotal(200)).toBe("silver");
    expect(levelForTotal(500)).toBe("gold");
    expect(levelForTotal(1000)).toBe("diamond");
    expect(levelForTotal(3000)).toBe("black");
  });

  it("respeita as faixas configuradas da casa", () => {
    const thresholds = { bronze: 50, silver: 100, gold: 5000, diamond: 10000, black: 50000 };
    expect(levelForTotal(3000, thresholds)).toBe("silver");
    expect(levelForTotal(49, thresholds)).toBe("novice");
    expect(levelForTotal(50000, thresholds)).toBe("black");
  });

  it("trata nulo e valores inválidos como zero", () => {
    expect(levelForTotal(null)).toBe("novice");
    expect(levelForTotal(undefined)).toBe("novice");
    expect(levelForTotal(Number.NaN)).toBe("novice");
  });
});

describe("thresholdsFromSettingsRow", () => {
  it("lê o jsonb e completa o que faltar com o padrão (igual ao RPC)", () => {
    expect(thresholdsFromSettingsRow({ bronze: 20, black: "8000" })).toEqual({
      ...DEFAULT_LEVEL_THRESHOLDS,
      bronze: 20,
      black: 8000,
    });
  });

  it("sem linha de configuração devolve o padrão", () => {
    expect(thresholdsFromSettingsRow(null)).toEqual(DEFAULT_LEVEL_THRESHOLDS);
    expect(thresholdsFromSettingsRow({ silver: "abc" })).toEqual(DEFAULT_LEVEL_THRESHOLDS);
  });
});
