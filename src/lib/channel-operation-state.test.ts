import { describe, expect, it } from "vitest";

import {
  audienceFromSearch,
  campaignStopReason,
  friendlyChannelReason,
  getChannelOperationState,
  groupVoiceQueueItems,
  isFinishedCampaignStatus,
  isPausedCampaignStatus,
} from "./channel-operation-state";
import { EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON } from "./tenant-channels.shared";

describe("getChannelOperationState", () => {
  it("traduz os estados operacionais exigidos em linguagem de produto", () => {
    expect(getChannelOperationState("agendada", "sms").label).toBe("Agendada");
    expect(getChannelOperationState("audio_ready", "voice").label).toBe("Aguardando provedor");
    expect(getChannelOperationState("retrying", "email").label).toBe("Tentando de novo");
    expect(getChannelOperationState("paused_limit", "sms").label).toBe("Pausada");
    expect(getChannelOperationState("paused_limit", "voice").label).toBe("Pausada por limite");
    expect(getChannelOperationState("enviando", "sms").label).toBe("Enviando");
    expect(getChannelOperationState("failed", "email").label).toBe("Falhou");
    expect(getChannelOperationState("???", "email").label).toBe("Status desconhecido");
  });

  it("rascunho não aparece como pronto para enviar", () => {
    expect(getChannelOperationState("rascunho", "email").label).toBe("Rascunho");
    expect(getChannelOperationState("draft", "sms").label).toBe("Rascunho");
    expect(getChannelOperationState("scheduled", "sms").label).toBe("Agendada");
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

  it("nenhum rótulo ou próxima ação fala em entrega (provedor não confirma)", () => {
    for (const status of ["agendada", "enviando", "enviado", "pausada", "failed", "x"]) {
      for (const channel of ["sms", "email", "voice"] as const) {
        const state = getChannelOperationState(status, channel);
        expect(`${state.label} ${state.description} ${state.nextAction}`).not.toMatch(/entreg/i);
      }
    }
  });

  it("campanha cancelada não aparece como falha", () => {
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
    // PG3 final fix I3: an SMS campaign paused for lack of balance says why.
    expect(campaignStopReason("pausada", "Saldo insuficiente", null)).toBe("Saldo insuficiente");
    expect(campaignStopReason("pausada", null, null)).toBeNull();
  });

  it("traduz o código bruto de canal desligado em vez de mostrá-lo cru", () => {
    expect(campaignStopReason("pausada", EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON, null)).toBe(
      "Canal E-mail desabilitado para a casa.",
    );
    expect(campaignStopReason("cancelada", EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON, null)).toBe(
      "Canal E-mail desabilitado para a casa.",
    );
    // Other reasons go through untouched.
    expect(campaignStopReason("pausada", "Saldo insuficiente", null)).toBe("Saldo insuficiente");
  });

  it("sempre fornece uma próxima ação navegável", () => {
    for (const channel of ["sms", "email", "voice"] as const) {
      const state = getChannelOperationState("unknown", channel);
      expect(state.nextAction).not.toHaveLength(0);
      expect(state.actionTo).toMatch(/^\//);
    }
  });

  it("web push: configuração aponta para /webhooks#webpush", () => {
    expect(getChannelOperationState("audio_ready", "webpush").actionTo).toBe("/webhooks#webpush");
  });

  it("web push pausado leva para saldo, igual SMS (não para configurações)", () => {
    const sms = getChannelOperationState("pausada", "sms");
    const webpush = getChannelOperationState("pausada", "webpush");
    expect(webpush.actionTo).toBe("/plano-e-creditos");
    expect(webpush.actionTo).toBe(sms.actionTo);
    expect(webpush.actionLabel).toBe("Ver saldo");
  });
});

describe("friendlyChannelReason", () => {
  it("mapeia o código bruto do e-mail para uma frase legível", () => {
    expect(friendlyChannelReason(EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON)).toBe(
      "Canal E-mail desabilitado para a casa.",
    );
  });

  it("não altera outros motivos, incluindo null/undefined", () => {
    expect(friendlyChannelReason("Saldo insuficiente")).toBe("Saldo insuficiente");
    expect(friendlyChannelReason(null)).toBeNull();
    expect(friendlyChannelReason(undefined)).toBeUndefined();
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

describe("isPausedCampaignStatus", () => {
  it("covers SMS/e-mail 'pausada' and the voice paused states", () => {
    for (const status of ["pausada", "Pausada ", "paused", "paused_limit"]) {
      expect(isPausedCampaignStatus(status)).toBe(true);
    }
    for (const status of [
      "agendada",
      "enviando",
      "concluida",
      "falhou",
      "cancelada",
      "",
      null,
      undefined,
    ]) {
      expect(isPausedCampaignStatus(status)).toBe(false);
    }
  });
});

describe("audienceFromSearch", () => {
  it("keeps system and saved audience ids from Públicos and Níveis", () => {
    expect(audienceFromSearch("system:all-leads")).toBe("system:all-leads");
    expect(audienceFromSearch("system:level:gold")).toBe("system:level:gold");
    expect(audienceFromSearch("3f9a1c2b-1111-4222-8333-944455556666")).toBe(
      "3f9a1c2b-1111-4222-8333-944455556666",
    );
  });

  it("drops anything else", () => {
    expect(audienceFromSearch(null)).toBe("");
    expect(audienceFromSearch("<script>")).toBe("");
    expect(audienceFromSearch("system:")).toBe("");
  });
});
