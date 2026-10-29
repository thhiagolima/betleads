import { describe, expect, it } from "vitest";
import {
  activationAsksEntryScope,
  audienceMatches,
  activationTriggerConfig,
  defaultEntryScope,
  INCLUDE_BASE_START_AFTER,
  eventMaxAgeHours,
  eventYoungEnough,
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
    expect(
      nextJourneyWindowOpen(
        { window_start: "08:00", window_end: "22:00" },
        new Date("2026-10-07T15:00:00Z"),
      ),
    ).toBeNull();
    expect(
      nextJourneyWindowOpen(
        { window_start: "08:00", window_end: "22:00" },
        new Date("2026-10-08T02:00:00Z"),
      ),
    ).toBe("2026-10-08T11:00:00.000Z");
  });
  it("applies weekdays in Sao Paulo", () => {
    expect(
      nextJourneyWindowOpen(
        { window_start: "08:00", window_end: "22:00", weekdays: [1] },
        new Date("2026-10-09T23:00:00Z"),
      ),
    ).toBe("2026-10-12T11:00:00.000Z");
  });
  it("evaluates inactivity and re-entry", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(
      qualifiesForInactivity(
        { ultimo_login: "2026-10-05T11:00:00Z" },
        { field: "ultimo_login", hours: 24 },
        now,
      ),
    ).toBe(true);
    expect(journeyEntryKey("login", { reentry: "once" }, "evt-1", now)).toBe("once");
    expect(journeyEntryKey("login", { reentry: "per_occurrence" }, "evt-1", now)).toBe(
      "login:evt-1",
    );
    expect(
      journeyEntryKey(
        "login",
        { reentry: "after_cooldown", reentry_cooldown_hours: 24 },
        "evt-1",
        now,
      ),
    ).toMatch(/^login:cooldown:/);
    expect(
      triggerOccurrence("lead_cadastrado", { created_at: "created", updated_at: "updated" }),
    ).toBe("created");
    expect(triggerOccurrence("inactivity", { ultimo_jogo: "game" }, { field: "ultimo_jogo" })).toBe(
      "game",
    );
  });
});

describe("inactivity band upper bound (E-03)", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

  it("uses the journey exit threshold as the entry upper bound", () => {
    expect(
      inactivityUpperBoundHours(
        { field: "ultimo_deposito", hours: 48 },
        { inactivity_over_hours: 168 },
      ),
    ).toBe(168);
    expect(
      inactivityUpperBoundHours({ hours: 48, hours_max: 100 }, { inactivity_over_hours: 168 }),
    ).toBe(100);
    expect(inactivityUpperBoundHours({ hours: 720 }, { deposit: true })).toBeNull();
    expect(inactivityUpperBoundHours({ hours: 48 }, { inactivity_over_hours: "x" })).toBeNull();
  });

  it("only qualifies players inside [hours, hours_max)", () => {
    const esfriando = { field: "ultimo_deposito", hours: 48, hours_max: 168 };
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(72) }, esfriando, now)).toBe(true);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(24) }, esfriando, now)).toBe(false);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(168) }, esfriando, now)).toBe(false);
    expect(qualifiesForInactivity({ ultimo_deposito: hoursAgo(40 * 24) }, esfriando, now)).toBe(
      false,
    );
    // Without an upper bound (30 dias) every older player still qualifies.
    expect(
      qualifiesForInactivity(
        { ultimo_deposito: hoursAgo(40 * 24) },
        { field: "ultimo_deposito", hours: 720 },
        now,
      ),
    ).toBe(true);
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

describe("entry event max age (P0.3)", () => {
  it("defaults per trigger; other triggers have no limit", () => {
    expect(eventMaxAgeHours("cadastrados_sem_deposito", {})).toBe(168);
    expect(eventMaxAgeHours("primeiro_deposito", {})).toBe(72);
    expect(eventMaxAgeHours("saque_pago", {})).toBe(24);
    expect(eventMaxAgeHours("inactivity", {})).toBeNull();
    expect(eventMaxAgeHours("pix_gerado_nao_pago", {})).toBeNull();
  });

  it("max_event_age_hours overrides; 0 disables; invalid keeps the default", () => {
    expect(eventMaxAgeHours("saque_pago", { max_event_age_hours: 6 })).toBe(6);
    expect(eventMaxAgeHours("saque_pago", { max_event_age_hours: 0 })).toBeNull();
    expect(eventMaxAgeHours("saque_pago", { max_event_age_hours: "bad" })).toBe(24);
  });

  it("eventYoungEnough compares the event time against the max age", () => {
    const now = Date.parse("2026-10-29T12:00:00.000Z");
    const hoursAgo = (h: number) => now - h * 3600_000;
    expect(eventYoungEnough("cadastrados_sem_deposito", {}, hoursAgo(167), now)).toBe(true);
    expect(eventYoungEnough("cadastrados_sem_deposito", {}, hoursAgo(169), now)).toBe(false);
    expect(eventYoungEnough("inactivity", {}, hoursAgo(10_000), now)).toBe(true);
    expect(eventYoungEnough("cadastrados_sem_deposito", {}, Number.NaN, now)).toBe(false);
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
    const picked = new Set(
      Array.from({ length: 40 }, (_, i) => pickSmsVariant(variants, `seed-${i}`, [])),
    );
    expect(picked.size).toBe(variants.length);
  });

  it("avoids variants already used today until all were used", () => {
    expect(pickSmsVariant(variants, "seed-1", [0, 1, 2])).toBe(3);
    for (let i = 0; i < 20; i++)
      expect([1, 3]).toContain(pickSmsVariant(variants, `s${i}`, [0, 2]));
    const all = pickSmsVariant(variants, "seed-1", [0, 1, 2, 3]);
    expect(all).toBeGreaterThanOrEqual(0);
  });
});

describe("activation entry scope (E-02)", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("defaults to new cases for event triggers and to the base for inactivity", () => {
    expect(defaultEntryScope("saque_pago")).toBe("new_only");
    expect(defaultEntryScope("pix_gerado_nao_pago")).toBe("new_only");
    expect(defaultEntryScope("cadastrados_sem_deposito")).toBe("new_only");
    expect(defaultEntryScope("inactivity")).toBe("include_base");
  });

  it("does not ask for level or manual journeys", () => {
    expect(activationAsksEntryScope("nivel_alterado")).toBe(false);
    expect(activationAsksEntryScope("manual")).toBe(false);
    expect(activationAsksEntryScope("inactivity")).toBe(true);
  });

  it("new cases only starts the journey now", () => {
    expect(
      activationTriggerConfig(
        "inactivity",
        { field: "ultimo_deposito", hours: 48 },
        "new_only",
        now,
      ),
    ).toEqual({ field: "ultimo_deposito", hours: 48, start_after: "2026-10-16T12:00:00.000Z" });
  });

  it("including the base lifts start_after only on state triggers", () => {
    const config = { start_after: "2026-10-15T10:00:00.000Z", hours: 48 };
    expect(activationTriggerConfig("inactivity", config, "include_base", now)).toEqual({
      hours: 48,
    });
    expect(activationTriggerConfig("saque_pago", config, "include_base", now)).toEqual(config);
    expect(activationTriggerConfig("pix_gerado_nao_pago", config, "include_base", now)).toEqual(
      config,
    );
    expect(activationTriggerConfig("inactivity", config, undefined, now)).toEqual(config);
  });

  it("P0.4: including the base on an event trigger without start_after sets an explicit start", () => {
    expect(activationTriggerConfig("cadastrados_sem_deposito", {}, "include_base", now)).toEqual({
      start_after: INCLUDE_BASE_START_AFTER,
    });
    expect(
      activationTriggerConfig("cashback_pago", { start_after: "" }, "include_base", now),
    ).toEqual({
      start_after: INCLUDE_BASE_START_AFTER,
    });
    // Without a scope nothing is added here: the database trigger stamps the activation time.
    expect(activationTriggerConfig("cadastrados_sem_deposito", {}, undefined, now)).toEqual({});
  });
});

describe("audienceMatches (E-06)", () => {
  it("follows the journey audience", () => {
    expect(
      audienceMatches({ entry_rules: { audience: "system:all-leads" } }, { status: "inativo" }),
    ).toBe(true);
    expect(
      audienceMatches({ entry_rules: { audience: "all_active" } }, { status: "inativo" }),
    ).toBe(false);
    expect(
      audienceMatches({ entry_rules: { audience: "vip" } }, { status: "ativo", vip: false }),
    ).toBe(false);
    expect(audienceMatches({ entry_rules: { audience: "manual" } }, { status: "ativo" })).toBe(
      false,
    );
  });
});
