import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: { provider_accounts: [] as Row[], tenant_channel_providers: [] as Row[] },
  failReads: false,
  reads: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: "provider_accounts" | "tenant_channel_providers") {
      return {
        select: async () => {
          state.reads++;
          if (state.failReads) return { data: null, error: { message: "connection reset" } };
          return { data: state.tables[table], error: null };
        },
      };
    },
  },
}));

import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  PROVIDER_ACCOUNTS_CACHE_MS,
  ProviderAccountUnavailableError,
  resolveChannelAccount,
  resolveInfobipAccount,
  resolveSmsAccount,
} from "./provider-accounts.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "./secret-box.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const OWN_SMS = "11111111-1111-4111-8111-111111111111";
const OWN_INFOBIP = "22222222-2222-4222-8222-222222222222";

const ENV_KEYS = [
  "SHORTCODE_SMS_TOKEN",
  "SHORTCODE_SMS_URL",
  "SHORT_BRASIL_SMS_USUARIO",
  "SHORT_BRASIL_SMS_CHAVE",
  "SHORT_BRASIL_SMS_SINGLE_URL",
  "SHORT_BRASIL_SMS_BULK_URL",
  "INFOBIP_BASE_URL",
  "INFOBIP_API_KEY",
  "INFOBIP_VOICE_FROM",
  "PROVIDER_CREDENTIALS_ENCRYPTION_KEY",
] as const;
const savedEnv: Partial<Record<string, string | undefined>> = {};

async function ownSmsAccount(overrides: Row = {}): Promise<Row> {
  return {
    id: OWN_SMS,
    provider: "short_brasil",
    label: "Short Brasil casa 1",
    channels: ["sms"],
    credentials_source: "db",
    credentials_encrypted: await encryptProviderCredentials({ shortcode_token: "own-token" }),
    config: { shortcode_url: "https://own.example.test/messages" },
    status: "active",
    ...overrides,
  };
}

async function ownInfobipAccount(overrides: Row = {}): Promise<Row> {
  return {
    id: OWN_INFOBIP,
    provider: "infobip",
    label: "Infobip casa 1",
    channels: ["email", "voice"],
    credentials_source: "db",
    credentials_encrypted: await encryptProviderCredentials({ api_key: "own-key" }),
    config: { base_url: "https://own.api.infobip.test/", voice_from: "+55 11 3000-0000" },
    status: "active",
    ...overrides,
  };
}

function assign(tenantId: string, channel: string, accountId: string) {
  state.tables.tenant_channel_providers.push({
    tenant_id: tenantId,
    channel,
    provider_account_id: accountId,
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "k".repeat(40);
  process.env.SHORTCODE_SMS_TOKEN = "platform-token";
  process.env.INFOBIP_BASE_URL = "https://platform.api.infobip.test/";
  process.env.INFOBIP_API_KEY = "platform-key";
  process.env.INFOBIP_VOICE_FROM = "5511999990000";
  state.tables = { provider_accounts: [], tenant_channel_providers: [] };
  state.failReads = false;
  state.reads = 0;
  __resetProviderAccountsCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveChannelAccount", () => {
  it("uses the platform accounts from the env when there is no house", async () => {
    const sms = await resolveSmsAccount(null);
    expect(sms).toMatchObject({
      id: DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
      shortcodeToken: "platform-token",
      shortcodeUrl: "https://api.shortcode.com.br/messages",
    });
    const email = await resolveInfobipAccount(undefined, "email");
    expect(email).toMatchObject({
      id: DEFAULT_INFOBIP_ACCOUNT_ID,
      baseUrl: "https://platform.api.infobip.test",
      apiKey: "platform-key",
      voiceFrom: "5511999990000",
    });
    expect(state.reads).toBe(0);
  });

  it("uses the platform account for a house without its own account", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount());
    assign(OTHER_TENANT, "sms", OWN_SMS);
    expect((await resolveSmsAccount(TENANT)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
  });

  it("uses the house's own account per channel, with decrypted credentials", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount(), await ownInfobipAccount());
    assign(TENANT, "sms", OWN_SMS);
    assign(TENANT, "voice", OWN_INFOBIP);

    expect(await resolveSmsAccount(TENANT)).toMatchObject({
      id: OWN_SMS,
      shortcodeToken: "own-token",
      shortcodeUrl: "https://own.example.test/messages",
    });
    expect(await resolveInfobipAccount(TENANT, "voice")).toMatchObject({
      id: OWN_INFOBIP,
      baseUrl: "https://own.api.infobip.test",
      apiKey: "own-key",
      voiceFrom: "551130000000",
    });
    // E-mail was not assigned: still the platform account.
    expect((await resolveInfobipAccount(TENANT, "email")).id).toBe(DEFAULT_INFOBIP_ACCOUNT_ID);
  });

  it("never falls back to the platform account when the house's account is disabled", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount({ status: "disabled" }));
    assign(TENANT, "sms", OWN_SMS);
    await expect(resolveSmsAccount(TENANT)).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );
  });

  it("rejects unreadable credentials, a missing account and the wrong channel or provider", async () => {
    state.tables.provider_accounts.push(
      await ownSmsAccount({ credentials_encrypted: "v1.bad.payload" }),
      await ownInfobipAccount({ channels: ["email", "voice", "sms"] }),
    );
    assign(TENANT, "sms", OWN_SMS);
    assign(OTHER_TENANT, "sms", OWN_INFOBIP);
    await expect(resolveSmsAccount(TENANT)).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );

    // Fase 4: an Infobip account also sends SMS.
    expect(await resolveSmsAccount(OTHER_TENANT)).toMatchObject({
      id: OWN_INFOBIP,
      provider: "infobip",
      apiKey: "own-key",
      smsFrom: "",
    });

    __resetProviderAccountsCacheForTests();
    state.tables.provider_accounts = [await ownInfobipAccount({ channels: ["email"] })];
    state.tables.tenant_channel_providers = [];
    assign(TENANT, "voice", OWN_INFOBIP);
    assign(OTHER_TENANT, "email", "33333333-3333-4333-8333-333333333333");
    await expect(resolveChannelAccount(TENANT, "voice")).rejects.toThrow(/não atende/);
    await expect(resolveChannelAccount(OTHER_TENANT, "email")).rejects.toThrow(/não existe mais/);
  });

  it("caches the tables for PROVIDER_ACCOUNTS_CACHE_MS", async () => {
    vi.useFakeTimers();
    state.tables.provider_accounts.push(await ownSmsAccount());
    assign(TENANT, "sms", OWN_SMS);
    await resolveSmsAccount(TENANT);
    await resolveSmsAccount(TENANT);
    expect(state.reads).toBe(2); // one snapshot = two table reads

    // A change made by the super admin shows up after the cache expires.
    state.tables.tenant_channel_providers = [];
    vi.advanceTimersByTime(PROVIDER_ACCOUNTS_CACHE_MS + 1);
    expect((await resolveSmsAccount(TENANT)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
    expect(state.reads).toBe(4);
  });

  it("keeps the last snapshot when the tables cannot be read, else the platform account", async () => {
    vi.useFakeTimers();
    state.failReads = true;
    expect((await resolveSmsAccount(TENANT)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);

    state.failReads = false;
    state.tables.provider_accounts.push(await ownSmsAccount());
    assign(TENANT, "sms", OWN_SMS);
    expect((await resolveSmsAccount(TENANT)).id).toBe(OWN_SMS);

    state.failReads = true;
    vi.advanceTimersByTime(PROVIDER_ACCOUNTS_CACHE_MS + 1);
    expect((await resolveSmsAccount(TENANT)).id).toBe(OWN_SMS);
  });

  it("an extra 'env' account reuses the env credentials under its own id", async () => {
    state.tables.provider_accounts.push({
      id: OWN_INFOBIP,
      provider: "infobip",
      label: "Infobip espelho",
      channels: ["email"],
      credentials_source: "env",
      credentials_encrypted: null,
      config: {},
      status: "active",
    });
    assign(TENANT, "email", OWN_INFOBIP);
    expect(await resolveInfobipAccount(TENANT, "email")).toMatchObject({
      id: OWN_INFOBIP,
      label: "Infobip espelho",
      apiKey: "platform-key",
    });
  });
});

describe("secret-box", () => {
  it("round-trips credentials and never stores them in clear text", async () => {
    const sealed = await encryptProviderCredentials({ api_key: "segredo-123" });
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("segredo-123");
    expect(await decryptProviderCredentials(sealed)).toEqual({ api_key: "segredo-123" });
  });

  it("fails with another key and without a configured key", async () => {
    const sealed = await encryptProviderCredentials({ api_key: "segredo-123" });
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "z".repeat(40);
    await expect(decryptProviderCredentials(sealed)).rejects.toThrow();
    delete process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
    await expect(encryptProviderCredentials({ a: "b" })).rejects.toThrow(
      /PROVIDER_CREDENTIALS_ENCRYPTION_KEY/,
    );
  });
});
