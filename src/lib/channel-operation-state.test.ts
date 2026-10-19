import { describe, expect, it } from "vitest";

import { campaignStopReason, getChannelOperationState } from "./channel-operation-state";

describe("getChannelOperationState", () => {
  it("traduz os estados operacionais exigidos em linguagem de produto", () => {
    expect(getChannelOperationState("agendada", "sms").label).toBe("Pronto para enviar");
    expect(getChannelOperationState("audio_ready", "voice").label).toBe("Aguardando provedor");
    expect(getChannelOperationState("retrying", "email").label).toBe("Em retentativa");
    expect(getChannelOperationState("paused_limit", "sms").label).toBe("Pausado por limite");
    expect(getChannelOperationState("failed", "email").label).toBe("Ação necessária");
  });

  it("campanha cancelada não aparece como ação necessária", () => {
    expect(getChannelOperationState("cancelada", "sms").label).toBe("Cancelada");
    expect(getChannelOperationState("cancelled", "voice").label).toBe("Cancelada");
  });

  it("retorna o motivo de campanha cancelada ou com falha", () => {
    expect(campaignStopReason("cancelada", "Cancelada manualmente por a@b.com em 19/10/2026.", null))
      .toBe("Cancelada manualmente por a@b.com em 19/10/2026.");
    expect(campaignStopReason("cancelada", null, "2026-10-19T15:49:43.287Z")).toBe(
      "Cancelada manualmente em 19/10/2026, 12:49.",
    );
    expect(campaignStopReason("falhou", "Saldo insuficiente", null)).toBe("Saldo insuficiente");
    expect(campaignStopReason("enviado", "erro antigo", null)).toBeNull();
  });

  it("sempre fornece uma próxima ação navegável", () => {
    for (const channel of ["sms", "email", "voice"] as const) {
      const state = getChannelOperationState("unknown", channel);
      expect(state.nextAction).not.toHaveLength(0);
      expect(state.actionTo).toMatch(/^\//);
    }
  });
});
