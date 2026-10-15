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
