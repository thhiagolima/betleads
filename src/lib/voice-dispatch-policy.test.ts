import { describe, expect, it } from "vitest";
import { isVoiceDispatchEnabled } from "./voice-dispatch-policy";

describe("voice dispatch policy", () => {
  it("fails closed when the operational switch is absent or invalid", () => {
    expect(isVoiceDispatchEnabled({})).toBe(false);
    expect(isVoiceDispatchEnabled({ VOICE_DISPATCH_ENABLED: "false" })).toBe(false);
    expect(isVoiceDispatchEnabled({ VOICE_DISPATCH_ENABLED: "TRUE" })).toBe(false);
  });

  it("enables automatic calls only with the explicit true value", () => {
    expect(isVoiceDispatchEnabled({ VOICE_DISPATCH_ENABLED: "true" })).toBe(true);
  });
});
