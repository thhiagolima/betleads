import { describe, expect, it } from "vitest";
import {
  journeyStepInputSchema,
  waitStepDueAt,
  waitStepsSpanSeconds,
  waitStepUntilTime,
} from "./journeys.shared";

// 2026-11-19 10:15 in Brasília (UTC-3).
const at = (iso: string) => Date.parse(iso);
const brt = (ms: number | null) =>
  ms == null ? null : new Date(ms - 3 * 3600_000).toISOString().slice(0, 16);

describe("waitStepDueAt", () => {
  it("keeps plain waits as a fixed delay", () => {
    expect(waitStepDueAt({ delay_seconds: 3600 }, at("2026-11-19T13:15:00Z"))).toBe(
      at("2026-11-19T14:15:00Z"),
    );
    expect(waitStepDueAt({ delay_seconds: 30 }, 0)).toBeNull();
  });

  it("waits for the same day when the time is still ahead", () => {
    expect(
      brt(waitStepDueAt({ delay_seconds: 0, until_time: "19:40" }, at("2026-11-19T13:15:00Z"))),
    ).toBe("2026-11-19T19:40");
  });

  it("moves to the next day when the time already passed", () => {
    expect(
      brt(waitStepDueAt({ delay_seconds: 0, until_time: "08:00" }, at("2026-11-19T13:15:00Z"))),
    ).toBe("2026-11-20T08:00");
  });

  it("uses Brasília's day, not UTC's, late at night", () => {
    // 23:30 BRT is 02:30 UTC of the next day.
    expect(
      brt(waitStepDueAt({ delay_seconds: 0, until_time: "08:00" }, at("2026-11-20T02:30:00Z"))),
    ).toBe("2026-11-20T08:00");
  });

  it("waits the minimum first, then for the time", () => {
    // 07:00 BRT + 6 h = 13:00 → next 08:00 is tomorrow.
    expect(
      brt(
        waitStepDueAt({ delay_seconds: 6 * 3600, until_time: "08:00" }, at("2026-11-19T10:00:00Z")),
      ),
    ).toBe("2026-11-20T08:00");
  });

  it("rejects invalid configs", () => {
    expect(waitStepDueAt({ delay_seconds: 0, until_time: "25:00" }, 0)).toBeNull();
    expect(waitStepUntilTime({ delay_seconds: 0, until_time: "8:00" })).toBeNull();
  });

  it("estimates the span of clock waits from a noon entry", () => {
    expect(
      waitStepsSpanSeconds([
        { delay_seconds: 0, until_time: "08:00" },
        { delay_seconds: 0, until_time: "19:40" },
      ]),
    ).toBe((20 + 11) * 3600 + 40 * 60);
  });
});

describe("wait step schema", () => {
  it("accepts a wait for a time of day without a minimum", () => {
    expect(
      journeyStepInputSchema.safeParse({
        step_type: "wait",
        config: { delay_seconds: 0, until_time: "08:00" },
      }).success,
    ).toBe(true);
  });

  it("still requires 1 minute for a plain wait", () => {
    expect(
      journeyStepInputSchema.safeParse({ step_type: "wait", config: { delay_seconds: 0 } }).success,
    ).toBe(false);
  });
});
