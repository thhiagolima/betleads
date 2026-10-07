import { describe, expect, it } from "vitest";

import {
  CHANNEL_WORKSPACE_DESTINATIONS,
  resolveChannelWorkspaceSection,
} from "./channel-workspace-nav";

describe("channel workspace navigation", () => {
  it("oferece todas as etapas para os tres canais", () => {
    const expected = ["overview", "create", "library", "campaigns", "history", "settings"];
    for (const channel of ["sms", "email", "voice"] as const) {
      expect(Object.keys(CHANNEL_WORKSPACE_DESTINATIONS[channel])).toEqual(expected);
      for (const destination of Object.values(CHANNEL_WORKSPACE_DESTINATIONS[channel])) {
        expect(destination.to.startsWith("/")).toBe(true);
      }
    }
  });

  it("reconhece bibliotecas e configuracoes legadas no estado ativo", () => {
    expect(resolveChannelWorkspaceSection("sms", "/sms/templates", "")).toBe("library");
    expect(resolveChannelWorkspaceSection("email", "/email", "smtp")).toBe("settings");
    expect(resolveChannelWorkspaceSection("voice", "/ligacoes", "scripts")).toBe("library");
  });

  it("direciona a criacao dos tres canais para o composer unificado", () => {
    for (const channel of ["sms", "email", "voice"] as const) {
      const destination = CHANNEL_WORKSPACE_DESTINATIONS[channel].create;
      expect(destination.to).toBe("/campanhas");
      expect(destination.search).toEqual({ newChannel: channel });
    }
  });
});
