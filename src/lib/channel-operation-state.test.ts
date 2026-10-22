import { describe, expect, it } from "vitest";

import {
  campaignStopReason,
  getChannelOperationState,
  groupVoiceQueueItems,
  isFinishedCampaignStatus,
} from "./channel-operation-state";

describe("getChannelOperationState", () => {
  it("traduz os estados operacionais exigidos em linguagem de produto", () => {
    expect(getChannelOperationState("agendada", "sms").label).toBe("Pronto para enviar");
    expect(getChannelOperationState("audio_ready", "voice").label).toBe("Aguardando provedor");
    expect(getChannelOperationState("retrying", "email").label).toBe("Em retentativa");
    expect(getChannelOperationState("paused_limit", "sms").label).toBe("Pausado por limite");
    expect(getChannelOperationState("failed", "email").label).toBe("Ação necessária");
  });

  it("rascunho não aparece como pronto para enviar", () => {
    expect(getChannelOperationState("rascunho", "email").label).toBe("Rascunho");
    expect(getChannelOperationState("draft", "sms").label).toBe("Rascunho");
    expect(getChannelOperationState("scheduled", "sms").label).toBe("Pronto para enviar");
  });

  it("finalizadas incluem voz concluída e excluem pausadas", () => {
    for (const status of [
      "enviado",
      "concluida",
      "completed",
      "falhou",
      "failed",
      "cancelada",
      "cancelled",
    ]) {
      expect(isFinishedCampaignStatus(status)).toBe(true);
    }
    for (const status of [
      "pausada",
      "paused",
      "paused_limit",
      "agendada",
      "enviando",
      "rascunho",
      null,
    ]) {
      expect(isFinishedCampaignStatus(status)).toBe(false);
    }
  });

  it("campanha cancelada não aparece como ação necessária", () => {
    expect(getChannelOperationState("cancelada", "sms").label).toBe("Cancelada");
    expect(getChannelOperationState("cancelled", "voice").label).toBe("Cancelada");
  });

  it("retorna o motivo de campanha cancelada ou com falha", () => {
    expect(
      campaignStopReason("cancelada", "Cancelada manualmente por a@b.com em 19/10/2026.", null),
    ).toBe("Cancelada manualmente por a@b.com em 19/10/2026.");
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

describe("groupVoiceQueueItems", () => {
  const now = new Date("2026-10-21T12:00:00.000Z").getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("agrupa as ligações de um mesmo disparo em uma campanha", () => {
    const groups = groupVoiceQueueItems(
      [
        { id: "a", status: "completed", scheduled_at: at(-30) },
        { id: "b", status: "failed", scheduled_at: at(-29.9) },
        { id: "c", status: "completed", scheduled_at: at(-29.5) },
        { id: "d", status: "cancelled", scheduled_at: at(-29) },
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "a",
      name: "Campanha de voz",
      total: 4,
      sent: 2,
      completed: 2,
      failed: 1,
      cancelled: 1,
      finished: 4,
      status: "concluida",
    });
  });

  it("separa disparos distantes no tempo, com áudio diferente ou com outro nome", () => {
    const groups = groupVoiceQueueItems(
      [
        { id: "a", status: "completed", scheduled_at: at(-120) },
        { id: "b", status: "completed", scheduled_at: at(-60) },
        { id: "c", status: "completed", scheduled_at: at(-60), audio_url: "https://x/1" },
        { id: "d", status: "completed", scheduled_at: at(-60), trigger_name: "Reativação" },
      ],
      now,
    );
    expect(groups.map((group) => group.itemIds)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(groups[0].name).toBe("Ligação por voz");
    expect(groups[3].name).toBe("Reativação");
  });

  it("deriva o status da campanha a partir das ligações", () => {
    const status = (items: Parameters<typeof groupVoiceQueueItems>[0]) =>
      groupVoiceQueueItems(items, now)[0].status;
    expect(status([{ id: "a", status: "audio_ready", scheduled_at: at(60) }])).toBe("agendada");
    expect(
      status([
        { id: "a", status: "completed", scheduled_at: at(-1) },
        { id: "b", status: "waiting_provider", scheduled_at: at(-1) },
      ]),
    ).toBe("enviando");
    expect(
      status([
        { id: "a", status: "audio_ready", provider_status: "cooldown", scheduled_at: at(-1) },
      ]),
    ).toBe("paused_limit");
    expect(status([{ id: "a", status: "failed", scheduled_at: at(-1) }])).toBe("falhou");
    expect(status([{ id: "a", status: "cancelled", scheduled_at: at(-1) }])).toBe("cancelada");
  });
});
