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

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import type { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  assertNoNewDisabledChannelSteps,
  channelBaselineSteps,
  disabledChannelsFor,
} from "./journeys.functions";
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
  fake.admin.reset();
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
    // Armazenado vem do banco com id; o editor manda o passo sem id.
    const stored: StepLike[] = [{ id: "s1", step_type: "voice", config: { asset_id: "a1" } }];
    const incoming: StepLike[] = [{ step_type: "voice", config: { asset_id: "a1" } }];
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

  // Fix review finding #1: saveJourney rebuilds an email/sms step's
  // `template_snapshot` fresh on every save (the server re-resolves the
  // referenced template's current content), so an untouched step must not
  // be flagged just because the template's content changed since the last
  // save — only the user's own input (template_id, sender, etc.) counts.
  it("passo de e-mail inalterado (mesmo id/template_id) com template_snapshot desatualizado continua salvável", async () => {
    smsOff();
    channels.getTenantChannels.mockResolvedValue({
      sms: { enabled: true, disabledAt: null },
      email: { enabled: false, disabledAt: "2026-11-05T00:00:00Z" },
      voice: { enabled: true, disabledAt: null },
      webpush: { enabled: false, disabledAt: null },
    });
    const stored: StepLike[] = [
      {
        id: "s1",
        step_type: "email",
        config: {
          template_id: "t1",
          template_snapshot: { id: "t1", subject: "Antigo", body_html: "<p>Antigo</p>", version: 1 },
        },
      },
    ];
    // Mesmo passo (mesmo id, mesmo template_id); só o snapshot foi
    // re-resolvido com o conteúdo atual do template (editado em outro lugar).
    const incoming: StepLike[] = [
      {
        step_type: "email",
        config: {
          template_id: "t1",
          template_snapshot: { id: "t1", subject: "Novo", body_html: "<p>Novo</p>", version: 2 },
        },
      },
    ];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, stored, incoming),
    ).resolves.toBeUndefined();
  });

  it("passo de e-mail com template_id realmente alterado continua recusado (ignorar o snapshot não esconde uma mudança real)", async () => {
    channels.getTenantChannels.mockResolvedValue({
      sms: { enabled: true, disabledAt: null },
      email: { enabled: false, disabledAt: "2026-11-05T00:00:00Z" },
      voice: { enabled: true, disabledAt: null },
      webpush: { enabled: false, disabledAt: null },
    });
    const stored: StepLike[] = [
      {
        id: "s1",
        step_type: "email",
        config: { template_id: "t1", template_snapshot: { id: "t1", subject: "A", body_html: "<p>A</p>" } },
      },
    ];
    const incoming: StepLike[] = [
      {
        id: "s1",
        step_type: "email",
        config: { template_id: "t2", template_snapshot: { id: "t2", subject: "B", body_html: "<p>B</p>" } },
      },
    ];
    await expect(assertNoNewDisabledChannelSteps(TENANT, stored, incoming)).rejects.toThrow(
      "O canal E-mail está desabilitado para esta casa.",
    );
  });

  it("setJourneyStatus (publicar): compara contra a última versão publicada; sem versão publicada, lista vazia", async () => {
    smsOff();
    // Sem jornada publicada anterior (revision_of nulo): stored = [].
    const incoming: StepLike[] = [{ step_type: "sms", config: { content: "Oi" } }];
    await expect(assertNoNewDisabledChannelSteps(TENANT, [], incoming)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
    // A versão publicada já tinha o mesmo passo: continua publicável.
    // Rascunho e publicada têm ids de passo diferentes.
    const stored: StepLike[] = [{ id: "p1", step_type: "sms", config: { content: "Oi" } }];
    const incomingSame: StepLike[] = [{ id: "d1", step_type: "sms", config: { content: "Oi" } }];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, stored, incomingSame),
    ).resolves.toBeUndefined();
  });

  // Final review #1: o shape real de saveJourney — passos armazenados lidos
  // do banco (com id, config com chaves reordenadas pelo jsonb e com
  // template_snapshot) contra o payload do editor (sem id).
  it("saveJourney: jornada antiga inalterada (stored com id e chaves reordenadas, incoming sem id) continua salvável", async () => {
    smsOff();
    const stored: StepLike[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        step_type: "sms",
        config: {
          variants: [{ weight: 50, content: "B {{link}}" }],
          template_snapshot: { id: "t1", content: "velho" },
          link_url: "https://casa.bet",
          content: "Oi {{link}}",
        },
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        step_type: "wait",
        config: { delay_seconds: 3600 },
      },
    ];
    const incoming: StepLike[] = [
      {
        step_type: "sms",
        config: {
          content: "Oi {{link}}",
          link_url: "https://casa.bet",
          template_snapshot: { content: "novo", id: "t1" },
          variants: [{ content: "B {{link}}", weight: 50 }],
        },
      },
      { step_type: "wait", config: { delay_seconds: 3600 } },
    ];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, stored, incoming),
    ).resolves.toBeUndefined();
    // Mudar o texto ainda é recusado.
    const changed: StepLike[] = [
      { ...incoming[0], config: { ...incoming[0].config, content: "Outro {{link}}" } },
    ];
    await expect(assertNoNewDisabledChannelSteps(TENANT, stored, changed)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
  });
});

describe("channelBaselineSteps (setJourneyStatus: publicar/reativar)", () => {
  const JOURNEY = "33333333-3333-4333-8333-333333333333";
  const PUBLISHED = "44444444-4444-4444-8444-444444444444";

  it("reativar jornada pausada sem revision_of compara contra os próprios passos: passo de canal desligado inalterado é permitido", async () => {
    voiceOff();
    fake.admin.rows("journey_steps").push(
      { id: "s-voice", journey_id: JOURNEY, tenant_id: TENANT, step_type: "voice", config: { asset_id: "a1", label: "x" }, is_enabled: true },
      { id: "s-other", journey_id: "outra", tenant_id: TENANT, step_type: "voice", config: { asset_id: "zz" }, is_enabled: true },
    );
    const baseline = await channelBaselineSteps(TENANT, { id: JOURNEY, revision_of: null });
    expect(baseline.map((s) => s.id)).toEqual(["s-voice"]);
    // `actionable` lido do banco pelo setJourneyStatus, com chaves em outra ordem.
    const actionable: StepLike[] = [
      { id: "s-voice", step_type: "voice", config: { label: "x", asset_id: "a1" } },
    ];
    await expect(
      assertNoNewDisabledChannelSteps(TENANT, baseline, actionable),
    ).resolves.toBeUndefined();
  });

  it("publicar rascunho com revision_of compara contra a versão publicada (ids diferentes)", async () => {
    voiceOff();
    fake.admin.rows("journey_steps").push(
      { id: "pub-1", journey_id: PUBLISHED, tenant_id: TENANT, step_type: "voice", config: { asset_id: "a1" }, is_enabled: true },
      { id: "draft-1", journey_id: JOURNEY, tenant_id: TENANT, step_type: "voice", config: { asset_id: "a1" }, is_enabled: true },
      { id: "draft-2", journey_id: JOURNEY, tenant_id: TENANT, step_type: "voice", config: { asset_id: "a2" }, is_enabled: true },
    );
    const baseline = await channelBaselineSteps(TENANT, { id: JOURNEY, revision_of: PUBLISHED });
    expect(baseline.map((s) => s.id)).toEqual(["pub-1"]);
    const draft = fake.admin
      .rows("journey_steps")
      .filter((r) => r.journey_id === JOURNEY) as unknown as StepLike[];
    await expect(assertNoNewDisabledChannelSteps(TENANT, baseline, [draft[0]])).resolves.toBeUndefined();
    await expect(assertNoNewDisabledChannelSteps(TENANT, baseline, draft)).rejects.toThrow(
      "O canal Voz está desabilitado para esta casa.",
    );
  });
});
