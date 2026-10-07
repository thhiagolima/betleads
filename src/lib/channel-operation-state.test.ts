import { describe, expect, it } from "vitest";

import { getChannelOperationState } from "./channel-operation-state";

describe("getChannelOperationState", () => {
  it("traduz os estados operacionais exigidos em linguagem de produto", () => {
    expect(getChannelOperationState("agendada", "sms").label).toBe("Pronto para enviar");
    expect(getChannelOperationState("audio_ready", "voice").label).toBe("Aguardando provedor");
    expect(getChannelOperationState("retrying", "email").label).toBe("Em retentativa");
    expect(getChannelOperationState("paused_limit", "sms").label).toBe("Pausado por limite");
    expect(getChannelOperationState("failed", "email").label).toBe("Ação necessária");
  });

  it("sempre fornece uma próxima ação navegável", () => {
    for (const channel of ["sms", "email", "voice"] as const) {
      const state = getChannelOperationState("unknown", channel);
      expect(state.nextAction).not.toHaveLength(0);
      expect(state.actionTo).toMatch(/^\//);
    }
  });
});
