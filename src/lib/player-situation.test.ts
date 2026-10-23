import { describe, expect, it } from "vitest";

import {
  daysWithoutDeposit,
  playerSituation,
  situationSettingsFromRow,
  SITUATION_LABEL,
} from "./player-situation";

const NOW = new Date("2026-10-23T12:00:00Z").getTime();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const settings = { coolingAfterDays: 2, sleepingAfterDays: 7 };

describe("playerSituation", () => {
  it("is 'no_deposit' without FTD and without deposited total", () => {
    expect(playerSituation({ total_depositado: 0, ftd_em: null }, settings, NOW)).toBe(
      "no_deposit",
    );
    expect(playerSituation({ total_depositado: null }, settings, NOW)).toBe("no_deposit");
  });

  it("is 'no_deposit' when there is a total but no deposit date at all", () => {
    expect(playerSituation({ total_depositado: 50, ftd_em: null }, settings, NOW)).toBe(
      "no_deposit",
    );
  });

  it("uses the configured cooling and sleeping days", () => {
    const base = { total_depositado: 100, ftd_em: daysAgo(30) };
    expect(playerSituation({ ...base, ultimo_deposito: daysAgo(1) }, settings, NOW)).toBe("active");
    expect(playerSituation({ ...base, ultimo_deposito: daysAgo(2) }, settings, NOW)).toBe(
      "cooling",
    );
    expect(playerSituation({ ...base, ultimo_deposito: daysAgo(6) }, settings, NOW)).toBe(
      "cooling",
    );
    expect(playerSituation({ ...base, ultimo_deposito: daysAgo(7) }, settings, NOW)).toBe(
      "sleeping",
    );
    expect(
      playerSituation(
        { ...base, ultimo_deposito: daysAgo(6) },
        { coolingAfterDays: 3, sleepingAfterDays: 5 },
        NOW,
      ),
    ).toBe("sleeping");
  });

  it("falls back to the FTD when there is no last deposit", () => {
    expect(
      playerSituation(
        { total_depositado: 0, ftd_em: daysAgo(10), ultimo_deposito: null },
        settings,
        NOW,
      ),
    ).toBe("sleeping");
  });

  it("labels every situation in pt-BR", () => {
    expect(SITUATION_LABEL).toEqual({
      active: "Ativo",
      cooling: "Esfriando",
      sleeping: "Dormindo",
      no_deposit: "Sem depósito",
    });
  });
});

describe("daysWithoutDeposit", () => {
  it("returns null for missing or invalid dates and never goes negative", () => {
    expect(daysWithoutDeposit({}, NOW)).toBeNull();
    expect(daysWithoutDeposit({ ultimo_deposito: "not a date" }, NOW)).toBeNull();
    expect(daysWithoutDeposit({ ultimo_deposito: daysAgo(-3) }, NOW)).toBe(0);
    expect(daysWithoutDeposit({ ultimo_deposito: daysAgo(4.5) }, NOW)).toBe(4);
  });
});

describe("situationSettingsFromRow", () => {
  it("reads the settings row with the snapshot defaults", () => {
    expect(situationSettingsFromRow(null)).toEqual(settings);
    expect(situationSettingsFromRow({ cooling_after_days: 3, sleeping_after_days: 10 })).toEqual({
      coolingAfterDays: 3,
      sleepingAfterDays: 10,
    });
    expect(situationSettingsFromRow({ cooling_after_days: "x" })).toEqual(settings);
  });
});
