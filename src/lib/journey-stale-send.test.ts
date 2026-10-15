import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { maxSendDelayMinutes, staleSendLatencyMinutes } from "./journeys.server";

const ENTERED = "2026-10-15T12:00:00.000Z";
const at = (minutesAfterEntry: number) => Date.parse(ENTERED) + minutesAfterEntry * 60_000;

describe("maxSendDelayMinutes", () => {
  it("defaults to 2 h for PIX and withdrawal journeys only", () => {
    expect(maxSendDelayMinutes("pix_gerado_nao_pago", {})).toBe(120);
    expect(maxSendDelayMinutes("saque_pago", {})).toBe(120);
    expect(maxSendDelayMinutes("inactivity", {})).toBeNull();
  });

  it("honours trigger_config.max_delay_minutes and 0 as disabled", () => {
    expect(maxSendDelayMinutes("saque_pago", { max_delay_minutes: 30 })).toBe(30);
    expect(maxSendDelayMinutes("saque_pago", { max_delay_minutes: 0 })).toBeNull();
    expect(maxSendDelayMinutes("inactivity", { max_delay_minutes: 60 })).toBe(60);
  });
});

describe("staleSendLatencyMinutes", () => {
  const base = { triggerType: "saque_pago", triggerConfig: {}, enteredAt: ENTERED, loopIteration: 0 };

  it("is on time within the limit, counting the waits before the step", () => {
    // Step after a 20 min wait, sent 2 h after its planned time: still on time.
    expect(staleSendLatencyMinutes({ ...base, waitSecondsBefore: 1200, now: at(20 + 120) })).toBeNull();
  });

  it("flags a step that is later than the limit", () => {
    expect(staleSendLatencyMinutes({ ...base, waitSecondsBefore: 0, now: at(121) })).toBe(121);
    expect(staleSendLatencyMinutes({ ...base, waitSecondsBefore: 1200, now: at(20 + 180) })).toBe(180);
  });

  it("never applies to journeys without a limit or to loop iterations", () => {
    expect(
      staleSendLatencyMinutes({ ...base, triggerType: "inactivity", waitSecondsBefore: 0, now: at(10_000) }),
    ).toBeNull();
    expect(staleSendLatencyMinutes({ ...base, loopIteration: 1, waitSecondsBefore: 0, now: at(10_000) })).toBeNull();
  });
});

describe("staleSendLatencyMinutes with a send window", () => {
  // PIX generated 22:30 BRT (01:30 UTC next day); window 08:00–22:00 BRT.
  const window = { window_start: "08:00", window_end: "22:00" };
  const base = {
    triggerType: "pix_gerado_nao_pago",
    triggerConfig: {},
    enteredAt: "2026-10-16T01:30:00.000Z",
    loopIteration: 0,
    entryRules: window,
  };

  it("does not treat waiting for the window as delay", () => {
    // Dia 1 sent 08:05 BRT (11:05 UTC): 5 min after the window opened.
    expect(
      staleSendLatencyMinutes({ ...base, waitSecondsBefore: 0, now: Date.parse("2026-10-16T11:05:00Z") }),
    ).toBeNull();
    // Dia 2 planned 22:30 BRT next day → due at 08:00 BRT the day after.
    expect(
      staleSendLatencyMinutes({ ...base, waitSecondsBefore: 86_400, now: Date.parse("2026-10-17T11:30:00Z") }),
    ).toBeNull();
  });

  it("still flags real delay after the window opened", () => {
    // 10:30 BRT = 150 min after the 08:00 opening.
    expect(
      staleSendLatencyMinutes({ ...base, waitSecondsBefore: 0, now: Date.parse("2026-10-16T13:30:00Z") }),
    ).toBe(150);
  });
});
