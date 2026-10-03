import { describe, expect, it, vi } from "vitest";
import { daysSinceActivity, hasActivitySince, lastActivityMs } from "./player-activity";

describe("player activity", () => {
  it("uses the most recent login, game or deposit", () => {
    expect(
      lastActivityMs({
        ultimo_login: "2026-10-01T10:00:00.000Z",
        ultimo_jogo: "2026-10-02T10:00:00.000Z",
        ultimo_deposito: "2026-10-03T10:00:00.000Z",
      }),
    ).toBe(new Date("2026-10-03T10:00:00.000Z").getTime());
  });

  it("treats a player without events as inactive", () => {
    expect(daysSinceActivity({})).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects activity after a flow enrollment", () => {
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    expect(hasActivitySince({ ultimo_jogo: "2026-10-03T11:00:00.000Z" }, "2026-10-03T10:00:00.000Z")).toBe(true);
    expect(hasActivitySince({ ultimo_login: "2026-10-03T09:00:00.000Z" }, "2026-10-03T10:00:00.000Z")).toBe(false);
    vi.useRealTimers();
  });
});
