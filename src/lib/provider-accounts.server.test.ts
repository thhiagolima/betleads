import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {
    provider_accounts: [] as Row[],
    tenant_channel_providers: [] as Row[],
    platform_channel_defaults: [] as Row[],
    tenant_channel_account_options: [] as Row[],
  },
  failReads: false,
  missingOptionsTable: false,
  reads: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(
      table:
        | "provider_accounts"
        | "tenant_channel_providers"
        | "platform_channel_defaults"
        | "tenant_channel_account_options",
    ) {
      return {
        select: async () => {
          state.reads++;
          if (state.failReads) return { data: null, error: { message: "connection reset" } };
          if (state.missingOptionsTable && table === "tenant_channel_account_options") {
            return {
              data: null,
              error: { code: "42P01", message: "relation \"tenant_channel_account_options\" does not exist" },
            };
          }
          return { data: state.tables[table], error: null };
        },
      };
    },
  },
}));

import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_INFOBIP_ACCOUNT_ID,
  DEFAULT_ONESIGNAL_ACCOUNT_ID,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
  assertSmsSendChoice,
  ENV_ACCOUNT_IDS,
  listSmsSendChoices,
  oneSignalAccountById,
  platformDefaultAccountId,
  PROVIDER_ACCOUNTS_CACHE_MS,
  ProviderAccountUnavailableError,
  resolveChannelAccount,
  resolveInfobipAccount,
  resolveOneSignalAccount,
  resolveSmsAccount,
  SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE,
  smsSendChoiceNames,
  smsSendChoiceProblem,
} from "./provider-accounts.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "./secret-box.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const OWN_SMS = "11111111-1111-4111-8111-111111111111";
const OWN_INFOBIP = "22222222-2222-4222-8222-222222222222";
const OWN_ONESIGNAL = "33333333-3333-4333-8333-333333333333";

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
  "ONESIGNAL_ORG_API_KEY",
  "ONESIGNAL_ORG_ID",
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

async function ownOneSignalAccount(overrides: Row = {}): Promise<Row> {
  return {
    id: OWN_ONESIGNAL,
    provider: "onesignal",
    label: "OneSignal casa 1",
    channels: ["webpush"],
    credentials_source: "db",
    credentials_encrypted: await encryptProviderCredentials({ org_api_key: "own-org-key" }),
    config: { org_id: "own-org-id" },
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

function setDefault(channel: string, accountId: string) {
  state.tables.platform_channel_defaults.push({ channel, provider_account_id: accountId });
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
  process.env.ONESIGNAL_ORG_API_KEY = "platform-org-key";
  process.env.ONESIGNAL_ORG_ID = "platform-org-id";
  state.tables = {
    provider_accounts: [],
    tenant_channel_providers: [],
    platform_channel_defaults: [],
    tenant_channel_account_options: [],
  };
  state.failReads = false;
  state.missingOptionsTable = false;
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
    expect(state.reads).toBe(4); // one snapshot = four table reads

    // A change made by the super admin shows up after the cache expires.
    state.tables.tenant_channel_providers = [];
    vi.advanceTimersByTime(PROVIDER_ACCOUNTS_CACHE_MS + 1);
    expect((await resolveSmsAccount(TENANT)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
    expect(state.reads).toBe(8);
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

describe("platform_channel_defaults: tenant without an override uses the chosen default", () => {
  it("webpush: uses the chosen default (a db OneSignal account)", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount());
    setDefault("webpush", OWN_ONESIGNAL);
    expect(await resolveOneSignalAccount(TENANT)).toMatchObject({ id: OWN_ONESIGNAL });
  });

  it("sms: the chosen default can be a db Infobip account", async () => {
    state.tables.provider_accounts.push(
      await ownInfobipAccount({ channels: ["email", "voice", "sms"] }),
    );
    setDefault("sms", OWN_INFOBIP);
    expect((await resolveChannelAccount(TENANT, "sms")).provider).toBe("infobip");
  });

  it("a send without a house ignores the chosen default", async () => {
    state.tables.provider_accounts.push(await ownInfobipAccount());
    setDefault("email", OWN_INFOBIP);
    expect((await resolveChannelAccount(null, "email")).id).toBe(DEFAULT_INFOBIP_ACCOUNT_ID);
  });

  it("a disabled chosen default never falls back to the env account", async () => {
    state.tables.provider_accounts.push(await ownInfobipAccount({ status: "disabled" }));
    setDefault("email", OWN_INFOBIP);
    await expect(resolveChannelAccount(TENANT, "email")).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );
  });

  it("a read failure with no snapshot yet uses the env account", async () => {
    state.failReads = true;
    expect((await resolveChannelAccount(TENANT, "sms")).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
  });

  it("the house's own override wins over the chosen default", async () => {
    state.tables.provider_accounts.push(
      await ownSmsAccount(),
      await ownInfobipAccount({ channels: ["email", "voice", "sms"] }),
    );
    setDefault("sms", OWN_INFOBIP);
    assign(TENANT, "sms", OWN_SMS);
    expect((await resolveChannelAccount(TENANT, "sms")).id).toBe(OWN_SMS);
  });
});

describe("platformDefaultAccountId", () => {
  it("returns the env id without a snapshot or a row for the channel", async () => {
    expect(await platformDefaultAccountId("sms")).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
    expect(ENV_ACCOUNT_IDS.has(await platformDefaultAccountId("webpush"))).toBe(true);
  });

  it("returns the chosen default's id once there is a snapshot and a row", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount());
    setDefault("webpush", OWN_ONESIGNAL);
    // Prime the snapshot (platformDefaultAccountId itself also triggers a load).
    expect(await platformDefaultAccountId("webpush")).toBe(OWN_ONESIGNAL);
  });
});

describe("resolveOneSignalAccount", () => {
  it("uses the platform account from the env when there is no house or no override", async () => {
    expect(await resolveOneSignalAccount(null)).toMatchObject({
      id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
      orgApiKey: "platform-org-key",
      orgId: "platform-org-id",
    });
    expect(await resolveOneSignalAccount(TENANT)).toMatchObject({
      id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
    });
  });

  it("uses the house's own account, with decrypted credentials", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount());
    assign(TENANT, "webpush", OWN_ONESIGNAL);

    expect(await resolveOneSignalAccount(TENANT)).toMatchObject({
      id: OWN_ONESIGNAL,
      provider: "onesignal",
      orgApiKey: "own-org-key",
      orgId: "own-org-id",
    });
    // Another house without an override still gets the platform account.
    expect((await resolveOneSignalAccount(OTHER_TENANT)).id).toBe(DEFAULT_ONESIGNAL_ACCOUNT_ID);
  });

  it("never falls back to the platform account when the house's account is disabled", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount({ status: "disabled" }));
    assign(TENANT, "webpush", OWN_ONESIGNAL);
    await expect(resolveOneSignalAccount(TENANT)).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );
  });

  it("rejects a missing account", async () => {
    assign(TENANT, "webpush", OWN_ONESIGNAL);
    await expect(resolveOneSignalAccount(TENANT)).rejects.toThrow(/não existe mais/);
  });
});

describe("oneSignalAccountById", () => {
  it("null or the default id returns the platform account", async () => {
    expect(await oneSignalAccountById(null)).toMatchObject({ id: DEFAULT_ONESIGNAL_ACCOUNT_ID });
    expect(await oneSignalAccountById(DEFAULT_ONESIGNAL_ACCOUNT_ID)).toMatchObject({
      id: DEFAULT_ONESIGNAL_ACCOUNT_ID,
    });
  });

  it("resolves a specific account by id, with decrypted credentials", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount());
    expect(await oneSignalAccountById(OWN_ONESIGNAL)).toMatchObject({
      id: OWN_ONESIGNAL,
      orgApiKey: "own-org-key",
    });
  });

  it("throws when the account is disabled or no longer exists", async () => {
    state.tables.provider_accounts.push(await ownOneSignalAccount({ status: "disabled" }));
    await expect(oneSignalAccountById(OWN_ONESIGNAL)).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );
    await expect(oneSignalAccountById("00000000-0000-4000-8000-000000009999")).rejects.toThrow(
      /não existe mais/,
    );
  });
});

describe("SMS account chosen per campaign (tenant_channel_account_options)", () => {
  function addOption(tenantId: string, accountId: string, displayName: string) {
    state.tables.tenant_channel_account_options.push({
      tenant_id: tenantId,
      channel: "sms",
      provider_account_id: accountId,
      display_name: displayName,
    });
  }

  it("resolves a house option; empty accountId keeps the house default", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount());
    addOption(TENANT, OWN_SMS, "Rota principal");
    expect((await resolveSmsAccount(TENANT)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
    expect((await resolveSmsAccount(TENANT, null)).id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
    expect(await resolveSmsAccount(TENANT, OWN_SMS)).toMatchObject({
      id: OWN_SMS,
      shortcodeToken: "own-token",
    });
  });

  it("accepts the account the house default resolves to today", async () => {
    expect((await resolveSmsAccount(TENANT, DEFAULT_SHORT_BRASIL_ACCOUNT_ID)).id).toBe(
      DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
    );
  });

  it("refuses an account that is not an option of THIS house, without leaking its label", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount());
    addOption(OTHER_TENANT, OWN_SMS, "Rota da outra casa");
    const error = await resolveSmsAccount(TENANT, OWN_SMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAccountUnavailableError);
    expect((error as Error).message).toBe(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
    await expect(resolveSmsAccount(null, OWN_SMS)).rejects.toBeInstanceOf(
      ProviderAccountUnavailableError,
    );
  });

  it("a disabled option account is unavailable (no fallback), with the generic message", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount({ status: "disabled" }));
    addOption(TENANT, OWN_SMS, "Rota principal");
    const error = await resolveSmsAccount(TENANT, OWN_SMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAccountUnavailableError);
    expect((error as Error).message).toBe(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
    expect((error as Error).message).not.toContain("Short Brasil");
  });

  it("lists 'Padrão da casa' first, then the options by name with availability", async () => {
    const DISABLED = "44444444-4444-4444-8444-444444444444";
    state.tables.provider_accounts.push(
      await ownSmsAccount(),
      await ownSmsAccount({ id: DISABLED, status: "disabled" }),
    );
    addOption(TENANT, OWN_SMS, "Rota B");
    addOption(TENANT, DISABLED, "Rota A");
    addOption(OTHER_TENANT, OWN_SMS, "Outra casa");
    expect(await listSmsSendChoices(TENANT)).toEqual([
      { id: null, name: "Padrão da casa", available: true },
      { id: DISABLED, name: "Rota A", available: false },
      { id: OWN_SMS, name: "Rota B", available: true },
    ]);
    expect(await listSmsSendChoices(null)).toEqual([
      { id: null, name: "Padrão da casa", available: true },
    ]);
  });

  it("assertSmsSendChoice: null passes; unknown or unavailable option throws in pt-BR", async () => {
    state.tables.provider_accounts.push(
      await ownSmsAccount({ credentials_encrypted: await encryptProviderCredentials({}) }),
    );
    addOption(TENANT, OWN_SMS, "Rota sem credencial");
    await expect(assertSmsSendChoice(TENANT, null)).resolves.toBeUndefined();
    await expect(assertSmsSendChoice(TENANT, undefined)).resolves.toBeUndefined();
    await expect(assertSmsSendChoice(TENANT, OWN_INFOBIP)).rejects.toThrow(
      /não existe para esta casa/,
    );
    // Account without credentials: listed, but not available.
    await expect(assertSmsSendChoice(TENANT, OWN_SMS)).rejects.toThrow(
      /"Rota sem credencial" está indisponível/,
    );
    expect(await smsSendChoiceProblem(TENANT, OWN_SMS)).toBe(SMS_SEND_ACCOUNT_UNAVAILABLE_MESSAGE);
    expect(await smsSendChoiceProblem(TENANT, null)).toBeNull();
  });

  it("smsSendChoiceNames: default, option name, removed option", async () => {
    state.tables.provider_accounts.push(await ownSmsAccount());
    addOption(TENANT, OWN_SMS, "Rota principal");
    const nameOf = await smsSendChoiceNames(TENANT);
    expect(nameOf(null)).toBe("Padrão da casa");
    expect(nameOf(OWN_SMS)).toBe("Rota principal");
    expect(nameOf(OWN_INFOBIP)).toBe("Conta removida");
  });

  it("a missing options table (app before the migration) is just no options", async () => {
    state.missingOptionsTable = true;
    state.tables.provider_accounts.push(await ownSmsAccount());
    assign(TENANT, "sms", OWN_SMS);
    expect((await resolveSmsAccount(TENANT)).id).toBe(OWN_SMS);
    expect(await listSmsSendChoices(TENANT)).toEqual([
      { id: null, name: "Padrão da casa", available: true },
    ]);
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
