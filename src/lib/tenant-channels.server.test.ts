// Per-house channel state (sms/email/voice/webpush): design in
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import {
  assertChannelEnabled,
  ChannelDisabledError,
  getTenantChannels,
  isChannelEnabled,
  __resetTenantChannelsCacheForTests,
} from "./tenant-channels.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
});

afterEach(() => vi.useRealTimers());

describe("getTenantChannels", () => {
  it("casa sem linhas usa o padrão (sms/email/voice ligados, webpush desligado)", async () => {
    const channels = await getTenantChannels(TENANT);
    expect(channels).toEqual({
      sms: { enabled: true, disabledAt: null },
      email: { enabled: true, disabledAt: null },
      voice: { enabled: true, disabledAt: null },
      webpush: { enabled: false, disabledAt: null },
    });
  });

  it("linha enabled=false sobrepõe o padrão só para essa casa/canal", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "voice",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });

    const channels = await getTenantChannels(TENANT);
    expect(channels.voice).toEqual({ enabled: false, disabledAt: "2026-11-05T00:00:00Z" });
    expect(channels.sms).toEqual({ enabled: true, disabledAt: null });

    const other = await getTenantChannels(OTHER_TENANT);
    expect(other.voice).toEqual({ enabled: true, disabledAt: null });
  });
});

describe("isChannelEnabled", () => {
  it("tenantId null é sempre true (e-mails/envios sem casa)", async () => {
    await expect(isChannelEnabled(null, "voice")).resolves.toBe(true);
  });

  it("reflete a linha da casa", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "voice",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });
    await expect(isChannelEnabled(TENANT, "voice")).resolves.toBe(false);
    await expect(isChannelEnabled(TENANT, "sms")).resolves.toBe(true);
  });
});

describe("assertChannelEnabled", () => {
  it("lança ChannelDisabledError com a mensagem e o rótulo reais do canal", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "voice",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });

    const error = await assertChannelEnabled(TENANT, "voice").catch((e) => e);
    expect(error).toBeInstanceOf(ChannelDisabledError);
    expect(error.channel).toBe("voice");
    expect(error.message).toBe("O canal Voz está desabilitado para esta casa.");
  });

  it("não lança quando o canal está ligado (ou tenantId é null)", async () => {
    await expect(assertChannelEnabled(TENANT, "sms")).resolves.toBeUndefined();
    await expect(assertChannelEnabled(null, "voice")).resolves.toBeUndefined();
  });
});

describe("cache: erro de leitura mantém o último valor", () => {
  it("uma leitura boa seguida de erro continua servindo o snapshot anterior", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "voice",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });

    const first = await getTenantChannels(TENANT);
    expect(first.voice.enabled).toBe(false);

    // Passa o TTL do cache (sem invalidar) e a próxima leitura falha: deve
    // manter o snapshot anterior, não cair no padrão.
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);
    fake.db.failNext("tenant_channels", "select", "simulated failure");

    const afterFailure = await getTenantChannels(TENANT);
    expect(afterFailure).toEqual(first);
  });

  it("sem nenhum snapshot anterior, erro de leitura usa o padrão", async () => {
    fake.db.failNext("tenant_channels", "select", "simulated failure");
    const channels = await getTenantChannels(TENANT);
    expect(channels).toEqual({
      sms: { enabled: true, disabledAt: null },
      email: { enabled: true, disabledAt: null },
      voice: { enabled: true, disabledAt: null },
      webpush: { enabled: false, disabledAt: null },
    });
  });
});
