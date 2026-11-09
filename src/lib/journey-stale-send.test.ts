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

describe("staleSendLatencyMinutes overnight (sends are 24h, no send window)", () => {
  // PIX generated 22:30 BRT (01:30 UTC next day).
  const base = {
    triggerType: "pix_gerado_nao_pago",
    triggerConfig: {},
    enteredAt: "2026-10-16T01:30:00.000Z",
    loopIteration: 0,
  };

  it("counts the night as delay: the step was due at entry", () => {
    // Sent 08:05 BRT (11:05 UTC): 575 min after entry, past the 2 h limit.
    expect(
      staleSendLatencyMinutes({ ...base, waitSecondsBefore: 0, now: Date.parse("2026-10-16T11:05:00Z") }),
    ).toBe(575);
    // Sent 23:30 BRT, 1 h after entry: on time.
    expect(
      staleSendLatencyMinutes({ ...base, waitSecondsBefore: 0, now: Date.parse("2026-10-16T02:30:00Z") }),
    ).toBeNull();
  });
});
