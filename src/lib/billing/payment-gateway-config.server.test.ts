import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { decryptProviderCredentials, encryptProviderCredentials } from "@/lib/secret-box.server";

import {
  deletePaymentGatewayCredentials,
  describePaymentGateways,
  getActivePixProvider,
  getSpacePayConfig,
  getUpperConfig,
  invalidatePaymentGatewayConfigCache,
  maskDocument,
  maskSecret,
  savePaymentGatewayCredentials,
  setActivePixProvider,
  spacePayCallbackSecrets,
  upperWebhookSecrets,
  type SpacePayConfig,
  type UpperConfig,
} from "./payment-gateway-config.server";

const ACTOR = "00000000-0000-4000-8000-0000000000dd";

const ENV_KEYS = [
  "PROVIDER_CREDENTIALS_ENCRYPTION_KEY",
  "BILLING_PIX_PROVIDER",
  "UPPER_API_KEY",
  "UPPER_WEBHOOK_SECRET",
  "UPPER_API_BASE",
  "SPACEPAY_GATEWAY_TOKEN",
  "SPACEPAY_CASINO_TOKEN",
  "SPACEPAY_PLATFORM_ID",
  "SPACEPAY_CALLBACK_SECRET",
  "SPACEPAY_API_BASE",
  "SPACEPAY_PAYER_NAME",
  "SPACEPAY_PAYER_DOCUMENT",
  "SPACEPAY_PAYER_EMAIL",
  "SPACEPAY_PAYER_PHONE",
] as const;

const saved: Record<string, string | undefined> = {};

const SPACEPAY_ENV = {
  SPACEPAY_GATEWAY_TOKEN: "env-gateway-token-0000000000",
  SPACEPAY_CALLBACK_SECRET: "env-callback-secret-1111111111",
  SPACEPAY_PAYER_NAME: "BetLeads Ltda",
  SPACEPAY_PAYER_DOCUMENT: "123.548.349-00",
  SPACEPAY_PAYER_EMAIL: "financeiro@betleads.com",
  SPACEPAY_PAYER_PHONE: "+55 11 98888-7777",
};

const DB_UPPER: UpperConfig = {
  apiKey: "db-upper-api-key-ABCDEFGH-wxyz",
  webhookSecret: "db-upper-webhook-secret-9999",
  apiBase: null,
};

const DB_SPACEPAY: SpacePayConfig = {
  gatewayToken: "eyJhbGciOiJIUzI1NiJ9.payload.sig9f2c",
  casinoToken: null,
  platformId: "casino-platform-42",
  callbackSecret: "db-callback-secret-2222222222",
  apiBase: "https://sandbox.spacedev.pro",
  payer: {
    name: "Outra Empresa",
    document: "12.345.678/0001-90",
    email: "pix@outra.com",
    phone: "11977776666",
  },
};

function setEnv(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "test-key-0123456789abcdef0123456789abcdef";
  fake.admin.reset();
  invalidatePaymentGatewayConfigCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("env fallback", () => {
  it("upper: env when UPPER_API_KEY is set, none otherwise", async () => {
    expect(await getUpperConfig()).toEqual({ source: "none", config: null });
    invalidatePaymentGatewayConfigCache();
    setEnv({ UPPER_API_KEY: " key-1 ", UPPER_WEBHOOK_SECRET: "wh", UPPER_API_BASE: "" });
    expect(await getUpperConfig()).toEqual({
      source: "env",
      config: { apiKey: "key-1", webhookSecret: "wh", apiBase: null },
    });
  });

  it("spacepay: env when every required var is set", async () => {
    setEnv({
      ...SPACEPAY_ENV,
      SPACEPAY_CASINO_TOKEN: "casino",
      SPACEPAY_PLATFORM_ID: " platform-7 ",
      SPACEPAY_API_BASE: "https://x",
    });
    expect(await getSpacePayConfig()).toEqual({
      source: "env",
      config: {
        gatewayToken: SPACEPAY_ENV.SPACEPAY_GATEWAY_TOKEN,
        casinoToken: "casino",
        platformId: "platform-7",
        callbackSecret: SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET,
        apiBase: "https://x",
        payer: {
          name: "BetLeads Ltda",
          document: "123.548.349-00",
          email: "financeiro@betleads.com",
          phone: "+55 11 98888-7777",
        },
      },
    });
  });

  it("spacepay: SPACEPAY_PLATFORM_ID is optional (null when unset)", async () => {
    setEnv(SPACEPAY_ENV);
    const loaded = await getSpacePayConfig();
    expect(loaded.source).toBe("env");
    expect(loaded.config?.platformId).toBeNull();
    expect((await describePaymentGateways()).gateways.spacepay.hints).not.toHaveProperty(
      "platformId",
    );
  });

  it.each(Object.keys(SPACEPAY_ENV))("spacepay: none when %s is missing", async (missing) => {
    setEnv(SPACEPAY_ENV);
    delete process.env[missing];
    expect(await getSpacePayConfig()).toEqual({ source: "none", config: null });
  });
});

describe("database rows", () => {
  it("a DB row wins entirely over env (no field mixing)", async () => {
    setEnv({
      UPPER_API_KEY: "env-key",
      UPPER_WEBHOOK_SECRET: "env-wh",
      UPPER_API_BASE: "https://env",
    });
    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    expect(await getUpperConfig()).toEqual({ source: "database", config: DB_UPPER });

    setEnv(SPACEPAY_ENV);
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    expect(await getSpacePayConfig()).toEqual({ source: "database", config: DB_SPACEPAY });
  });

  it("a SpacePay row saved before platformId existed loads fine (platformId null)", async () => {
    const legacy = await encryptProviderCredentials({
      gatewayToken: DB_SPACEPAY.gatewayToken,
      callbackSecret: DB_SPACEPAY.callbackSecret,
      payerName: "Outra Empresa",
      payerDocument: "12.345.678/0001-90",
      payerEmail: "pix@outra.com",
      payerPhone: "11977776666",
    });
    fake.admin.rows("payment_gateway_accounts").push({
      provider: "spacepay",
      credentials_encrypted: legacy,
      hints: {},
      updated_at: "2026-11-01T00:00:00Z",
    });
    expect(await getSpacePayConfig()).toEqual({
      source: "database",
      config: { ...DB_SPACEPAY, apiBase: null, platformId: null },
    });
    expect(console.error).not.toHaveBeenCalled();
    const view = await describePaymentGateways();
    expect(view.gateways.spacepay.source).toBe("database");
    expect(view.gateways.spacepay.hints).not.toHaveProperty("platformId");
  });

  it("decrypt failure falls back to env and never logs the secret", async () => {
    setEnv({ UPPER_API_KEY: "env-key" });
    // Encrypted under another key: decrypt throws.
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "another-key-0123456789abcdef0123456789";
    const foreign = await encryptProviderCredentials({ apiKey: "very-secret-upper-key" });
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "test-key-0123456789abcdef0123456789abcdef";
    fake.admin.rows("payment_gateway_accounts").push({
      provider: "upper",
      credentials_encrypted: foreign,
      hints: {},
      updated_at: "2026-11-01T00:00:00Z",
    });

    expect(await getUpperConfig()).toEqual({
      source: "env",
      config: { apiKey: "env-key", webhookSecret: null, apiBase: null },
    });
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls,
    );
    expect(logged).toContain("could not decrypt");
    expect(logged).not.toContain("very-secret-upper-key");
    expect(logged).not.toContain(foreign);
  });

  it("garbage ciphertext falls back to env; a DB read error too", async () => {
    setEnv({ UPPER_API_KEY: "env-key" });
    fake.admin.rows("payment_gateway_accounts").push({
      provider: "upper",
      credentials_encrypted: "not-a-ciphertext",
      hints: {},
      updated_at: null,
    });
    expect((await getUpperConfig()).source).toBe("env");

    invalidatePaymentGatewayConfigCache();
    fake.admin.failNext("payment_gateway_accounts", "select", "boom");
    expect((await getUpperConfig()).source).toBe("env");
  });

  it("a DB read error is not cached", async () => {
    setEnv({ UPPER_API_KEY: "env-key" });
    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    fake.admin.failNext("payment_gateway_accounts", "select", "boom");
    expect((await getUpperConfig()).source).toBe("env");
    expect((await getUpperConfig()).source).toBe("database");
  });
});

describe("cache", () => {
  it("caches for 30 s and the write helpers invalidate it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    expect((await getUpperConfig()).source).toBe("database");

    // Out-of-band delete: still cached.
    fake.admin.rows("payment_gateway_accounts").length = 0;
    vi.setSystemTime(new Date("2026-11-12T12:00:20Z"));
    expect((await getUpperConfig()).source).toBe("database");
    vi.setSystemTime(new Date("2026-11-12T12:00:31Z"));
    expect((await getUpperConfig()).source).toBe("none");

    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    expect((await getUpperConfig()).source).toBe("database");
    await deletePaymentGatewayCredentials("upper");
    expect((await getUpperConfig()).source).toBe("none");

    expect(await getActivePixProvider()).toBe("upper");
    await setActivePixProvider("spacepay", ACTOR);
    expect(await getActivePixProvider()).toBe("spacepay");
  });

  it("invalidatePaymentGatewayConfigCache forces a re-read", async () => {
    expect(await getActivePixProvider()).toBe("upper");
    fake.admin.rows("payment_gateway_settings").push({ id: true, active_provider: "spacepay" });
    expect(await getActivePixProvider()).toBe("upper");
    invalidatePaymentGatewayConfigCache();
    expect(await getActivePixProvider()).toBe("spacepay");
  });
});

describe("getActivePixProvider", () => {
  it("DB > env > upper", async () => {
    expect(await getActivePixProvider()).toBe("upper");
    process.env.BILLING_PIX_PROVIDER = " SpacePay ";
    invalidatePaymentGatewayConfigCache();
    expect(await getActivePixProvider()).toBe("spacepay");
    process.env.BILLING_PIX_PROVIDER = "bogus";
    invalidatePaymentGatewayConfigCache();
    expect(await getActivePixProvider()).toBe("upper");

    process.env.BILLING_PIX_PROVIDER = "spacepay";
    await setActivePixProvider("upper", ACTOR);
    expect(await getActivePixProvider()).toBe("upper");
    expect(fake.admin.rows("payment_gateway_settings")).toHaveLength(1);
    await setActivePixProvider("spacepay", ACTOR);
    expect(fake.admin.rows("payment_gateway_settings")).toEqual([
      expect.objectContaining({ id: true, active_provider: "spacepay", updated_by: ACTOR }),
    ]);
  });
});

describe("secret lists", () => {
  it("spacePayCallbackSecrets: DB + env, deduped, non-empty", async () => {
    expect(await spacePayCallbackSecrets()).toEqual([]);
    setEnv({ SPACEPAY_CALLBACK_SECRET: "  " });
    invalidatePaymentGatewayConfigCache();
    expect(await spacePayCallbackSecrets()).toEqual([]);

    setEnv(SPACEPAY_ENV);
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    expect(await spacePayCallbackSecrets()).toEqual([
      DB_SPACEPAY.callbackSecret,
      SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET,
    ]);

    // Rotating the DB secret keeps the replaced one accepted (24 h).
    await savePaymentGatewayCredentials(
      "spacepay",
      { ...DB_SPACEPAY, callbackSecret: SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET },
      ACTOR,
    );
    expect(await spacePayCallbackSecrets()).toEqual([
      SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET,
      DB_SPACEPAY.callbackSecret,
    ]);
  });

  it("upperWebhookSecrets: DB + replaced (24 h) + env, deduped, non-empty", async () => {
    setEnv({ UPPER_WEBHOOK_SECRET: "env-wh" });
    expect(await upperWebhookSecrets()).toEqual(["env-wh"]);
    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    expect(await upperWebhookSecrets()).toEqual([DB_UPPER.webhookSecret, "env-wh"]);
    await savePaymentGatewayCredentials("upper", { ...DB_UPPER, webhookSecret: null }, ACTOR);
    expect(await upperWebhookSecrets()).toEqual([DB_UPPER.webhookSecret, "env-wh"]);
  });

  it("a rotated secret stays accepted for 24 h, survives later saves, then expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    const rotated = "rotated-callback-secret-3333333333";
    await savePaymentGatewayCredentials("spacepay", { ...DB_SPACEPAY, callbackSecret: rotated }, ACTOR);
    expect(await spacePayCallbackSecrets()).toEqual([rotated, DB_SPACEPAY.callbackSecret]);

    // An unrelated save 20 h later keeps the ORIGINAL deadline.
    vi.setSystemTime(new Date("2026-11-13T08:00:00Z"));
    invalidatePaymentGatewayConfigCache();
    await savePaymentGatewayCredentials(
      "spacepay",
      { ...DB_SPACEPAY, callbackSecret: rotated, casinoToken: "casino-token-abcdef" },
      ACTOR,
    );
    expect(await spacePayCallbackSecrets()).toEqual([rotated, DB_SPACEPAY.callbackSecret]);

    vi.setSystemTime(new Date("2026-11-13T12:00:01Z"));
    invalidatePaymentGatewayConfigCache();
    expect(await spacePayCallbackSecrets()).toEqual([rotated]);
  });

  it("moving from env to the DB keeps the env secret accepted too", async () => {
    setEnv(SPACEPAY_ENV);
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    delete process.env.SPACEPAY_CALLBACK_SECRET;
    invalidatePaymentGatewayConfigCache();
    expect(await spacePayCallbackSecrets()).toEqual([
      DB_SPACEPAY.callbackSecret,
      SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET,
    ]);
  });
});

describe("savePaymentGatewayCredentials", () => {
  it("writes encrypted credentials and masked hints", async () => {
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    const [row] = fake.admin.rows("payment_gateway_accounts");
    expect(row.provider).toBe("spacepay");
    expect(row.updated_by).toBe(ACTOR);
    const encrypted = String(row.credentials_encrypted);
    expect(encrypted.startsWith("v1.")).toBe(true);
    for (const secret of [DB_SPACEPAY.gatewayToken, DB_SPACEPAY.callbackSecret, "345.678"]) {
      expect(encrypted).not.toContain(secret);
    }
    expect(await decryptProviderCredentials(encrypted)).toEqual({
      gatewayToken: DB_SPACEPAY.gatewayToken,
      platformId: "casino-platform-42",
      callbackSecret: DB_SPACEPAY.callbackSecret,
      apiBase: DB_SPACEPAY.apiBase,
      payerName: "Outra Empresa",
      payerDocument: "12.345.678/0001-90",
      payerEmail: "pix@outra.com",
      payerPhone: "11977776666",
    });
    expect(row.hints).toEqual({
      gatewayToken: "eyJh…9f2c",
      platformId: "casino-platform-42",
      callbackSecret: "db-c…2222",
      apiBase: "https://sandbox.spacedev.pro",
      payerName: "Outra Empresa",
      payerDocument: "**.345.678/0001-**",
      payerEmail: "pi•••@outra.com",
      payerPhone: "••••6666",
    });
    const hintsText = JSON.stringify(row.hints);
    expect(hintsText).not.toContain(DB_SPACEPAY.gatewayToken);
    expect(hintsText).not.toContain(DB_SPACEPAY.callbackSecret);
  });

  it("rejects incomplete credentials", async () => {
    await expect(
      savePaymentGatewayCredentials(
        "upper",
        { apiKey: " ", webhookSecret: null, apiBase: null },
        ACTOR,
      ),
    ).rejects.toThrow(/incompletas/);
    expect(fake.admin.rows("payment_gateway_accounts")).toHaveLength(0);
  });

  it("masks CPF/CNPJ and tokens", () => {
    expect(maskDocument("123.548.349-00")).toBe("***.548.349-**");
    expect(maskDocument("12345678000190")).toBe("**.345.678/0001-**");
    expect(maskDocument("123")).toBe("••••");
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd…mnop");
    expect(maskSecret("short")).toBe("••••");
  });
});

describe("describePaymentGateways", () => {
  it("returns sources and hints, never secrets", async () => {
    setEnv({ ...SPACEPAY_ENV, UPPER_API_KEY: "env-upper-key-1234567890" });
    expect(await describePaymentGateways()).toEqual({
      activeProvider: "upper",
      activeSource: "default",
      gateways: {
        upper: { source: "env", hints: { apiKey: "env-…7890" }, updatedAt: null },
        spacepay: expect.objectContaining({ source: "env", updatedAt: null }),
      },
    });

    await savePaymentGatewayCredentials("upper", DB_UPPER, ACTOR);
    await savePaymentGatewayCredentials("spacepay", DB_SPACEPAY, ACTOR);
    await setActivePixProvider("spacepay", ACTOR);
    const view = await describePaymentGateways();
    expect(view.activeProvider).toBe("spacepay");
    expect(view.activeSource).toBe("database");
    expect(view.gateways.upper.source).toBe("database");
    expect(view.gateways.spacepay.source).toBe("database");
    expect(typeof view.gateways.upper.updatedAt).toBe("string");

    const text = JSON.stringify(view);
    for (const secret of [
      DB_UPPER.apiKey,
      DB_UPPER.webhookSecret!,
      DB_SPACEPAY.gatewayToken,
      DB_SPACEPAY.callbackSecret,
      DB_SPACEPAY.payer.document,
      SPACEPAY_ENV.SPACEPAY_GATEWAY_TOKEN,
      SPACEPAY_ENV.SPACEPAY_CALLBACK_SECRET,
      "env-upper-key-1234567890",
    ]) {
      expect(text).not.toContain(secret);
    }

    await deletePaymentGatewayCredentials("upper");
    delete process.env.UPPER_API_KEY;
    expect((await describePaymentGateways()).gateways.upper).toEqual({
      source: "none",
      hints: {},
      updatedAt: null,
    });
  });
});
