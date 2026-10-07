import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callInfobipEmail } from "./infobip-email.server";
import { callInfobipVoice, normalizeE164BR } from "./infobip-voice.server";

const INFOBIP_ENV = [
  "INFOBIP_BASE_URL",
  "INFOBIP_API_KEY",
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
      "https://assets.example.test/call.mp3",
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
  });
});
