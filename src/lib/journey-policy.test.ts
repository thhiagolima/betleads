import { describe, expect, it } from "vitest";
import {
  inactivityUpperBoundHours,
  journeyEntryKey,
  nextJourneyWindowOpen,
  pickSmsVariant,
  pixExpiryHours,
  qualifiesForInactivity,
  smsVariants,
  triggerOccurrence,
} from "./journey-policy";

describe("journey policy", () => {
  it("applies the Sao Paulo window", () => {
    expect(nextJourneyWindowOpen({ window_start: "08:00", window_end: "22:00" }, new Date("2026-10-07T15:00:00Z"))).toBeNull();
    expect(nextJourneyWindowOpen({ window_start: "08:00", window_end: "22:00" }, new Date("2026-10-08T02:00:00Z"))).toBe("2026-10-08T11:00:00.000Z");
  });
  it("applies weekdays in Sao Paulo", () => {
    expect(nextJourneyWindowOpen({ window_start: "08:00", window_end: "22:00", weekdays: [1] }, new Date("2026-10-09T23:00:00Z"))).toBe("2026-10-12T11:00:00.000Z");
  });
  it("evaluates inactivity and re-entry", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(qualifiesForInactivity({ ultimo_login: "2026-10-05T11:00:00Z" }, { field: "ultimo_login", hours: 24 }, now)).toBe(true);
    expect(journeyEntryKey("login", { reentry: "once" }, "evt-1", now)).toBe("once");
    expect(journeyEntryKey("login", { reentry: "per_occurrence" }, "evt-1", now)).toBe("login:evt-1");
    expect(journeyEntryKey("login", { reentry: "after_cooldown", reentry_cooldown_hours: 24 }, "evt-1", now)).toMatch(/^login:cooldown:/);
    expect(triggerOccurrence("lead_cadastrado", { created_at: "created", updated_at: "updated" })).toBe("created");
    expect(triggerOccurrence("inactivity", { ultimo_jogo: "game" }, { field: "ultimo_jogo" })).toBe("game");
  });
});

describe("inactivity band upper bound (E-03)", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

  it("uses the journey exit threshold as the entry upper bound", () => {
    expect(inactivityUpperBoundHours({ field: "ultimo_deposito", hours: 48 }, { inactivity_over_hours: 168 })).toBe(168);
    expect(inactivityUpperBoundHours({ hours: 48, hours_max: 100 }, { inactivity_over_hours: 168 })).toBe(100);
    expect(inactivityUpperBoundHours({ hours: 720 }, { deposit: true })).toBeNull();
    expect(inactivityUpperBoundHours({ hours: 48 }, { inactivity_over_hours: "x" })).toBeNull();
  });

  it("only qualifies players inside [hours, hours_max)", () => {
    const esfriando = { field: "ultimo_deposito", hours: 48, hours_max: 168 };
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(72) }, esfriando, now)).toBe(true);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(24) }, esfriando, now)).toBe(false);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(168) }, esfriando, now)).toBe(false);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(40 * 24) }, esfriando, now)).toBe(false);
    // Without an upper bound (30 dias) every older player still qualifies.
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(40 * 24) }, { field: "ultimo_deposito", hours: 720 }, now)).toBe(true);
  });
});

describe("pix expiry (D-6)", () => {
  it("defaults to 72 hours and allows overriding or disabling", () => {
    expect(pixExpiryHours({})).toBe(72);
    expect(pixExpiryHours({ expire_hours: 24 })).toBe(24);
    expect(pixExpiryHours({ expire_hours: 0 })).toBeNull();
    expect(pixExpiryHours({ expire_hours: "bad" })).toBe(72);
  });
});

describe("sms variants (D-8)", () => {
  const variants = ["a", "b", "c", "d"];

  it("falls back to the single content", () => {
    expect(smsVariants({ content: "only" })).toEqual(["only"]);
    expect(smsVariants({ content: "x", variants: ["a", " ", "b"] })).toEqual(["a", "b"]);
    expect(smsVariants({ content: "x", variants: [] })).toEqual(["x"]);
  });

  it("is deterministic for the same seed", () => {
    const first = pickSmsVariant(variants, "saque_pago:w-1", []);
    expect(pickSmsVariant(variants, "saque_pago:w-1", [])).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(variants.length);
  });

  it("spreads across variants for different seeds", () => {
    const picked = new Set(Array.from({ length: 40 }, (_, i) => pickSmsVariant(variants, `seed-${i}`, [])));
    expect(picked.size).toBe(variants.length);
  });

  it("avoids variants already used today until all were used", () => {
    expect(pickSmsVariant(variants, "seed-1", [0, 1, 2])).toBe(3);
    for (let i = 0; i < 20; i++) expect([1, 3]).toContain(pickSmsVariant(variants, `s${i}`, [0, 2]));
    const all = pickSmsVariant(variants, "seed-1", [0, 1, 2, 3]);
    expect(all).toBeGreaterThanOrEqual(0);
  });
});
