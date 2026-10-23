import { describe, expect, it } from "vitest";

import { historyWindow, periodQuery } from "./channel-period";

// 23/10/2026 15:00 in Brasília (18:00 UTC).
const NOW = new Date("2026-10-23T18:00:00Z");

describe("periodQuery", () => {
  it("turns today into a single BRT day that includes today", () => {
    expect(periodQuery({ from: NOW, to: NOW }, NOW)).toEqual({
      from: "2026-10-23",
      to: "2026-10-23",
      sameDay: true,
      includesToday: true,
    });
  });

  it("uses the Brasília calendar day, not UTC, late at night", () => {
    // 23/10 22:30 in Brasília is already 24/10 in UTC.
    const lateNight = new Date("2026-10-24T01:30:00Z");
    expect(periodQuery({ from: lateNight, to: lateNight }, lateNight).from).toBe("2026-10-23");
  });

  it("keeps a past span and flags it as not including today", () => {
    const from = new Date("2026-09-01T15:00:00Z");
    const to = new Date("2026-09-30T15:00:00Z");
    expect(periodQuery({ from, to }, NOW)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      sameDay: false,
      includesToday: false,
    });
  });

  it("treats a half-picked range (only from) as that one day", () => {
    const from = new Date("2026-10-10T15:00:00Z");
    expect(periodQuery({ from, to: undefined }, NOW)).toMatchObject({
      from: "2026-10-10",
      to: "2026-10-10",
      sameDay: true,
    });
  });

  it("never asks for days after today", () => {
    const future = new Date("2026-11-05T15:00:00Z");
    expect(periodQuery({ from: NOW, to: future }, NOW).to).toBe("2026-10-23");
  });
});

describe("historyWindow", () => {
  it("leaves `to` open when the period reaches today and buckets a single day by hour", () => {
    expect(historyWindow({ from: NOW, to: NOW }, NOW)).toEqual({
      from: "2026-10-23T03:00:00.000Z",
      to: null,
      bucket: "hour",
    });
  });

  it("closes a past window at the end of its last BRT day and buckets by day", () => {
    const from = new Date("2026-10-01T15:00:00Z");
    const to = new Date("2026-10-07T15:00:00Z");
    expect(historyWindow({ from, to }, NOW)).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      to: "2026-10-08T02:59:59.999Z",
      bucket: "day",
    });
  });
});
