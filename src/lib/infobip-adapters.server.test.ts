import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The demo send guard has its own coverage (demo-send-guard.voice.test.ts);
// here it is a no-op so these adapter-level tests focus on the HTTP shape.
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));

// PG3 Task 4: the wallet reservation has its own coverage
// (infobip-voice.billing.test.ts); here it always succeeds.
vi.mock("./billing/wallet.server", () => ({
  reserveForDelivery: vi.fn(async () => ({ ok: true, referenceId: "voice:test", amount: 0, balance: 0 })),
  refundForDelivery: vi.fn(async () => undefined),
}));

// Per-house account resolution has its own coverage
// (provider-accounts.server.test.ts); here every house uses the platform
// account built from the env, without a database read.
vi.mock("./provider-accounts.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-accounts.server")>();
  return { ...actual, resolveInfobipAccount: vi.fn(async () => actual.envInfobipAccount()) };
});

// The callback-token store has its own coverage
// (provider-callback-tokens.server.test.ts): an owned account gets OWN_TOKEN.
const OWN_TOKEN = "pa_77777777777747778777777777777777_ownsecret";
vi.mock("./provider-callback-tokens.server", () => ({
  callbackTokenFor: vi.fn(async (account: { ownerTenantId: string | null }) =>
    account.ownerTenantId ? OWN_TOKEN : null,
  ),
}));

import { callInfobipEmail } from "./infobip-email.server";
import { envInfobipAccount, resolveInfobipAccount } from "./provider-accounts.server";
import { callInfobipVoice, normalizeE164BR } from "./infobip-voice.server";

const TENANT = "00000000-0000-4000-8000-000000000001";

const INFOBIP_ENV = [
  "INFOBIP_BASE_URL",
  "INFOBIP_API_KEY",
  "INFOBIP_EMAIL_CALLBACK_TOKEN",
  "INFOBIP_VOICE_FROM",
  "INFOBIP_VOICE_CALLBACK_TOKEN",
  "PUBLIC_APP_URL",
] as const;

describe("Infobip provider adapters", () => {
  beforeEach(() => {
    for (const key of INFOBIP_ENV) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of INFOBIP_ENV) delete process.env[key];
  });

  it("fails closed without email credentials and does not call the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await callInfobipEmail({
      to: "destinatario@example.test",
      from: "remetente@example.test",
      subject: "Teste",
      html: "<p>Teste</p>",
      idempotencyKey: "email-delivery-1",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      idempotencyKey: "email-delivery-1",
      temporary: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends email with provider authentication and callback correlation", async () => {
    process.env.INFOBIP_BASE_URL = "https://api.infobip.test/";
    process.env.INFOBIP_API_KEY = "test-api-key";
    process.env.INFOBIP_EMAIL_CALLBACK_TOKEN = "email-callback-token";
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ messageId: "email-provider-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callInfobipEmail({
      to: "destinatario@example.test",
      from: "remetente@example.test",
      fromName: "BETLEADS",
      replyTo: "suporte@example.test",
      subject: "Assunto",
      html: "<p>Mensagem</p>",
      idempotencyKey: "email-delivery-2",
    });

    expect(result).toMatchObject({ ok: true, status: 200, idempotencyKey: "email-delivery-2" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.infobip.test/email/3/send");
    expect(init.headers).toMatchObject({ Authorization: "App test-api-key" });
    const form = init.body as FormData;
    expect(form.get("from")).toBe("BETLEADS <remetente@example.test>");
    expect(form.get("callbackData")).toBe("email-delivery-2");
    expect(String(form.get("notifyUrl"))).toContain("/api/public/infobip/email/events");
    expect(String(form.get("notifyUrl"))).toContain("correlation=email-delivery-2");
    expect(form.get("notifyContentType")).toBe("application/json");
  });

  it("normalizes Brazilian numbers and builds a correlated voice request", async () => {
    process.env.INFOBIP_BASE_URL = "https://api.infobip.test/";
    process.env.INFOBIP_API_KEY = "test-api-key";
    process.env.INFOBIP_VOICE_FROM = "+551130000000";
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-token";
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ callId: "voice-provider-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(normalizeE164BR("(11) 99999-9999")).toBe("+5511999999999");
    const result = await callInfobipVoice(
      "+5511999999999",
      { type: "audio", audioUrl: "https://assets.example.test/call.mp3" },
      { tenantId: TENANT },
    );

    expect(result).toMatchObject({ ok: true, status: 200, providerCallId: "voice-provider-1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.infobip.test/markuplanguage/1/create");
    expect(init.headers).toMatchObject({ Authorization: "App test-api-key" });
    const body = JSON.parse(String(init.body));
    expect(body.endpoint.phoneNumber).toBe("5511999999999");
    expect(body.from).toBe("551130000000");
    expect(body.customData).toBe(result.idempotencyKey);
    expect(body.callback.url).toContain("token=callback-token");
    expect(body.callback.url).toContain("audio=https%3A%2F%2Fassets.example.test%2Fcall.mp3");
    expect(body.notifyUrl).toContain("correlation=" + result.idempotencyKey);
  });

  it("uses a correlated CML callback for Infobip-native TTS without exposing the script in the URL", async () => {
    process.env.INFOBIP_BASE_URL = "https://api.infobip.test/";
    process.env.INFOBIP_API_KEY = "test-api-key";
    process.env.INFOBIP_VOICE_FROM = "+551130000000";
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-token";
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ callId: "voice-provider-tts" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const script = "Olá, este é um lembrete reservado.";
    const result = await callInfobipVoice(
      "+5511999999999",
      {
        type: "tts",
        text: script,
        language: "pt",
      },
      { tenantId: TENANT },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.callback.url).toContain("mode=say");
    expect(body.callback.url).toContain("correlation=" + result.idempotencyKey);
    expect(body.callback.url).not.toContain("audio=");
    expect(body.callback.url).not.toContain(encodeURIComponent(script));
  });

  it("an owned account's e-mail and voice callback URLs carry the account token, never the global one", async () => {
    process.env.INFOBIP_EMAIL_CALLBACK_TOKEN = "email-callback-token";
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-token";
    process.env.INFOBIP_VOICE_FROM = "+551130000000";
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    const owned = {
      ...envInfobipAccount(),
      id: "77777777-7777-4777-8777-777777777777",
      ownerTenantId: TENANT,
      baseUrl: "https://own.api.infobip.test",
      apiKey: "own-key",
      voiceFrom: "551130000000",
    };
    vi.mocked(resolveInfobipAccount).mockResolvedValueOnce(owned).mockResolvedValueOnce(owned);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ callId: "c-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callInfobipEmail({
      to: "destinatario@example.test",
      from: "remetente@example.test",
      subject: "Assunto",
      html: "<p>Mensagem</p>",
      idempotencyKey: "email-owned-1",
      tenantId: TENANT,
    });
    const emailUrl = String((fetchMock.mock.calls[0][1].body as FormData).get("notifyUrl"));
    expect(emailUrl).toContain(`token=${OWN_TOKEN}`);
    expect(emailUrl).not.toContain("email-callback-token");
    expect(emailUrl).not.toContain("token=callback-token");

    await callInfobipVoice(
      "+5511999999999",
      { type: "audio", audioUrl: "https://assets.example.test/call.mp3" },
      { tenantId: TENANT },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    for (const url of [body.callback.url as string, body.notifyUrl as string]) {
      expect(url).toContain("token=pa_");
      expect(url).toContain(`token=${OWN_TOKEN}`);
      expect(url).not.toContain("token=callback-token");
    }
  });
});
