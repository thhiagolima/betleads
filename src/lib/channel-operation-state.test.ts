import { describe, expect, it } from "vitest";

import {
  audienceFromSearch,
  campaignStopReason,
  friendlyChannelReason,
  getChannelOperationState,
  groupVoiceQueueItems,
  isFinishedCampaignStatus,
  isPausedCampaignStatus,
  summarizeVoiceCampaign,
  summarizeVoiceCampaignCounts,
  VOICE_EMPTY_SENDING_STALE_MS,
  type VoiceCampaignRecord,
  type VoiceItemCount,
  type VoiceQueueItem,
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

describe("summarizeVoiceCampaign / summarizeVoiceCampaignCounts", () => {
  const now = new Date("2026-11-11T12:00:00.000Z").getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const campaign = (extra: Partial<VoiceCampaignRecord> = {}): VoiceCampaignRecord => ({
    id: "vc-1",
    name: "Reativação",
    status: "sending",
    scheduled_at: at(-30),
    created_at: at(-30),
    recipient_count: 10,
    ...extra,
  });

  // Same grouping as public.voice_campaign_item_counts: (status,
  // provider_status, coalesce(scheduled_at, created_at) > now), with the item
  // id when the group has exactly one item.
  function aggregate(items: VoiceQueueItem[]): VoiceItemCount[] {
    const groups = new Map<string, VoiceItemCount & { ids: string[] }>();
    for (const item of items) {
      const time = Date.parse(String(item.scheduled_at ?? item.created_at ?? ""));
      const isFuture = Number.isFinite(time) && time > now;
      const key = [item.status, item.provider_status ?? "", isFuture].join("|");
      const group = groups.get(key) ?? {
        status: item.status ?? null,
        provider_status: item.provider_status ?? null,
        is_future: isFuture,
        item_count: 0,
        ids: [],
      };
      group.item_count = Number(group.item_count) + 1;
      group.ids.push(item.id);
      groups.set(key, group);
    }
    return [...groups.values()].map(({ ids, ...row }) => ({
      ...row,
      // bigint arrives as a number; a string must work too.
      item_count: String(row.item_count),
      sample_item_id: ids.length === 1 ? ids[0] : null,
    }));
  }

  const item = (
    id: string,
    status: string,
    extra: Partial<VoiceQueueItem> = {},
  ): VoiceQueueItem => ({
    id,
    status,
    scheduled_at: at(-10),
    created_at: at(-20),
    ...extra,
  });

  const mixes: Record<string, VoiceQueueItem[]> = {
    vazia: [],
    "uma ligação": [item("a", "waiting_provider")],
    concluída: [item("a", "completed"), item("b", "completed"), item("c", "cancelled")],
    falhou: [item("a", "failed"), item("b", "cancelled")],
    cancelada: [item("a", "cancelled"), item("b", "cancelled")],
    enviando: [
      item("a", "completed"),
      item("b", "calling"),
      item("c", "audio_ready"),
      item("d", "audio_ready", { scheduled_at: at(30) }),
    ],
    "aguardando provedor": [item("a", "audio_ready"), item("b", "audio_ready")],
    agendada: [
      item("a", "audio_ready", { scheduled_at: at(60) }),
      item("b", "audio_ready", { scheduled_at: at(61) }),
    ],
    "pausada por limite": [
      item("a", "audio_ready", { provider_status: "cooldown" }),
      item("b", "audio_ready", { provider_status: "rolling_24h_limit", scheduled_at: at(60) }),
      item("c", "completed"),
    ],
    "sem horário": [item("a", "audio_ready", { scheduled_at: null, created_at: at(5) })],
    pendente: [item("a", "pending_audio"), item("b", "paused")],
  };

  it.each(Object.entries(mixes))("rows and counts give the same summary (%s)", (_, items) => {
    for (const stored of ["sending", "scheduled", "cancelled"]) {
      const record = campaign({ status: stored });
      const fromRows = summarizeVoiceCampaign(record, items, now);
      const fromCounts = summarizeVoiceCampaignCounts(record, aggregate(items), now);
      const { itemIds, ...rest } = fromRows;
      expect(fromCounts).toEqual({ ...rest, itemIds: itemIds.length === 1 ? itemIds : [] });
    }
  });

  it("a sending campaign with no item for over 10 minutes shows cancelled", () => {
    const stale = campaign({
      created_at: new Date(now - VOICE_EMPTY_SENDING_STALE_MS - 1).toISOString(),
    });
    expect(summarizeVoiceCampaignCounts(stale, [], now)).toMatchObject({
      status: "cancelada",
      campaignStatus: "cancelled",
      total: 0,
    });
    const fresh = campaign({ created_at: at(-2) });
    expect(summarizeVoiceCampaignCounts(fresh, [], now)).toMatchObject({
      status: "enviando",
      campaignStatus: "sending",
    });
    // A scheduled campaign keeps waiting for its time.
    expect(
      summarizeVoiceCampaignCounts(campaign({ status: "scheduled", created_at: at(-60) }), [], now),
    ).toMatchObject({ status: "agendada", campaignStatus: "scheduled" });
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
