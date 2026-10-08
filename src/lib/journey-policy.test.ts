import { describe, expect, it } from "vitest";
import { journeyEntryKey, nextJourneyWindowOpen, qualifiesForInactivity, triggerOccurrence } from "./journey-policy";

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
