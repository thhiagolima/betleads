// Task 7 (review fix #3) — scheduleBulkSms/sendBulkSms share
// `assertBulkSmsCanSend`, extracted so the guard can be unit-tested
// directly (createServerFn handlers can't: the TanStack Start compiler
// swaps their body for a client-side stub — see journeys.functions.ts's
// `assertNoNewDisabledChannelSteps`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
// assertTenantCanOperate/assertTenantNotDemoForSend are exercised by their
// own suites; here they're no-ops so only the channel guard is under test.
vi.mock("@/lib/tenant-access.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-access.server")>();
  return {
    ...actual,
    assertTenantCanOperate: vi.fn(async () => undefined),
    assertTenantNotDemoForSend: vi.fn(async () => undefined),
  };
});

import { __resetTenantChannelsCacheForTests } from "./tenant-channels.server";
import {
  assertBulkSmsCanSend,
  assertTestSmsCanSend,
  ScheduleBulkSchema,
  smsCampaignAccountColumn,
} from "./sms.functions";
import { __resetProviderAccountsCacheForTests } from "./provider-accounts.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  fake.db.reset();
  __resetTenantChannelsCacheForTests();
});

describe("assertBulkSmsCanSend (scheduleBulkSms/sendBulkSms guard)", () => {
  it("casa com SMS desligado lança CHANNEL_DISABLED_MESSAGE", async () => {
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "sms",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });
    await expect(assertBulkSmsCanSend(TENANT)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
  });

  it("casa sem linha (SMS ligado por padrão) resolve normalmente", async () => {
    await expect(assertBulkSmsCanSend(TENANT)).resolves.toBeUndefined();
  });
});

describe("conta de envio escolhida (sendBulkSms/scheduleBulkSms/sendTestSms)", () => {
  const EXTRA = "abababab-1111-4222-8333-444444444444";

  function extraOption(status = "active") {
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "platform-token");
    fake.db.rows("provider_accounts").push({
      id: EXTRA,
      provider: "short_brasil",
      label: "Short Brasil rota 2",
      channels: ["sms"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
      status,
    });
    fake.db.rows("tenant_channel_account_options").push({
      tenant_id: TENANT,
      channel: "sms",
      provider_account_id: EXTRA,
      display_name: "Rota principal",
    });
  }

  beforeEach(() => __resetProviderAccountsCacheForTests());
  afterEach(() => vi.unstubAllEnvs());

  it("null/ausente = padrão da casa: nada muda", async () => {
    await expect(assertBulkSmsCanSend(TENANT, null)).resolves.toBeUndefined();
    await expect(assertTestSmsCanSend(TENANT)).resolves.toBeUndefined();
  });

  it("uma opção ativa da casa passa (campanha e envio de teste)", async () => {
    extraOption();
    await expect(assertBulkSmsCanSend(TENANT, EXTRA)).resolves.toBeUndefined();
    await expect(assertTestSmsCanSend(TENANT, EXTRA)).resolves.toBeUndefined();
  });

  it("conta que não é opção da casa é recusada com erro claro", async () => {
    await expect(assertBulkSmsCanSend(TENANT, EXTRA)).rejects.toThrow(
      /não existe para esta casa/,
    );
    await expect(assertTestSmsCanSend(TENANT, EXTRA)).rejects.toThrow(
      /não existe para esta casa/,
    );
  });

  it("opção com a conta desativada é recusada como indisponível", async () => {
    extraOption("disabled");
    await expect(assertBulkSmsCanSend(TENANT, EXTRA)).rejects.toThrow(
      /"Rota principal" está indisponível/,
    );
    await expect(assertTestSmsCanSend(TENANT, EXTRA)).rejects.toThrow(
      /"Rota principal" está indisponível/,
    );
  });

  it("SMS desligado vence a escolha da conta no envio de teste", async () => {
    extraOption();
    fake.db.rows("tenant_channels").push({
      tenant_id: TENANT,
      channel: "sms",
      enabled: false,
      disabled_at: "2026-11-05T00:00:00Z",
    });
    await expect(assertTestSmsCanSend(TENANT, EXTRA)).rejects.toThrow(
      "O canal SMS está desabilitado para esta casa.",
    );
  });

  it("os schemas aceitam providerAccountId uuid/null e recusam lixo", () => {
    const base = {
      phones: ["+5511999990000"],
      content: "Oi",
      campaignName: "C",
      scheduledAt: "2099-01-01T00:00:00Z",
    };
    expect(ScheduleBulkSchema.parse({ ...base, providerAccountId: EXTRA }).providerAccountId).toBe(
      EXTRA,
    );
    expect(ScheduleBulkSchema.parse({ ...base, providerAccountId: null }).providerAccountId).toBeNull();
    expect(ScheduleBulkSchema.parse(base).providerAccountId).toBeUndefined();
    expect(() => ScheduleBulkSchema.parse({ ...base, providerAccountId: "x" })).toThrow();
  });

  it("smsCampaignAccountColumn só grava a coluna quando há conta escolhida", () => {
    expect(smsCampaignAccountColumn(null)).toEqual({});
    expect(smsCampaignAccountColumn(undefined)).toEqual({});
    expect(smsCampaignAccountColumn(EXTRA)).toEqual({ provider_account_id: EXTRA });
  });
});
