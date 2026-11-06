// Task 7 — journeys.functions.ts: recusar passo novo/alterado de canal
// desligado ao salvar/publicar a jornada.
//
// O compilador do TanStack Start troca o corpo dos `createServerFn` por um
// stub fora do servidor (mesmo padrão documentado em meta.functions.test.ts),
// então o teste exercita as funções puras exportadas que
// saveJourney/setJourneyStatus/convertLegacyJourney chamam antes de salvar.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderChannel } from "./tenant-channels.shared";

type ChannelsState = Record<ProviderChannel, { enabled: boolean; disabledAt: string | null }>;

const channels = vi.hoisted(() => ({
  getTenantChannels: vi.fn(
    async (): Promise<Record<string, { enabled: boolean; disabledAt: string | null }>> => ({
      sms: { enabled: true, disabledAt: null },
      email: { enabled: true, disabledAt: null },
      voice: { enabled: true, disabledAt: null },
      webpush: { enabled: false, disabledAt: null },
    }),
  ),
}));
vi.mock("./tenant-channels.server", () => ({ getTenantChannels: channels.getTenantChannels }));

import { assertNoNewDisabledChannelSteps, disabledChannelsFor } from "./journeys.functions";
import type { StepLike } from "./tenant-channels.shared";

const TENANT = "00000000-0000-4000-8000-000000000001";

function allOn() {
  channels.getTenantChannels.mockResolvedValue({
    sms: { enabled: true, disabledAt: null },
    email: { enabled: true, disabledAt: null },
    voice: { enabled: true, disabledAt: null },
    webpush: { enabled: false, disabledAt: null },
  } satisfies ChannelsState);
}

function voiceOff() {
  channels.getTenantChannels.mockResolvedValue({
    sms: { enabled: true, disabledAt: null },
    email: { enabled: true, disabledAt: null },
    voice: { enabled: false, disabledAt: "2026-11-05T00:00:00Z" },
    webpush: { enabled: false, disabledAt: null },
  } satisfies ChannelsState);
}

function smsOff() {
  channels.getTenantChannels.mockResolvedValue({
    sms: { enabled: false, disabledAt: "2026-11-05T00:00:00Z" },
    email: { enabled: true, disabledAt: null },
    voice: { enabled: true, disabledAt: null },
    webpush: { enabled: false, disabledAt: null },
  } satisfies ChannelsState);
}

beforeEach(() => {
  allOn();
});

describe("disabledChannelsFor", () => {
  it("devolve o conjunto de canais desligados da casa", async () => {
    voiceOff();
    expect(await disabledChannelsFor(TENANT)).toEqual(new Set(["voice", "webpush"]));
  });

  it("casa com tudo ligado (exceto webpush por padrão)", async () => {
    expect(await disabledChannelsFor(TENANT)).toEqual(new Set(["webpush"]));
  });
});

describe("assertNoNewDisabledChannelSteps (usado por saveJourney/setJourneyStatus/convertLegacyJourney)", () => {
  it("saveJourney: passo novo de canal desligado (sms) lança a mensagem de CHANNEL_DISABLED_MESSAGE", async () => {
    smsOff();
    const incoming: StepLike[] = [{ step_type: "sms", config: { content: "Oi" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, [], incoming)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
  });

  it("jornada antiga com passo de canal desligado inalterado continua salvável", async () => {
    voiceOff();
    const stored: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a1" } }];
    const incoming: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a1" } }];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, stored, incoming),
    ).resolves.toBeUndefined();
  });

  it("passo de canal desligado alterado é recusado mesmo mantendo o id", async () => {
    voiceOff();
    const stored: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a1" } }];
    const incoming: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a2" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, stored, incoming)).rejects.toThrow(
      "O canal Voz está desabilitado para esta casa.",
    );
  });

  it("passo removido (não está mais em incoming) não é recusado", async () => {
    voiceOff();
    const stored: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a1" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, stored, [])).resolves.toBeUndefined();
  });

  it("todos os canais ligados: nunca recusa, mesmo com passo novo", async () => {
    allOn();
    const incoming: StepLike[] = [{ step_type: "sms", config: { content: "Oi" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, [], incoming)).resolves.toBeUndefined();
  });

  it("setJourneyStatus (publicar): compara contra a última versão publicada; sem versão publicada, lista vazia", async () => {
    smsOff();
    // Sem jornada publicada anterior (revision_of nulo): stored = [].
    const incoming: StepLike[] = [{ step_type: "sms", config: { content: "Oi" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, [], incoming)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
    // A versão publicada já tinha o mesmo passo: continua publicável.
    const stored: StepLike[] = [{ id: "p1", step_type: "sms", config: { content: "Oi" } }];
    const incomingSame: StepLike[] = [{ id: "p1", step_type: "sms", config: { content: "Oi" } }];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, stored, incomingSame),
    ).resolves.toBeUndefined();
  });
});
