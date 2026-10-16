// ENV-02 — voice and e-mail never reach the provider twice for the same
// caller-supplied idempotency key once a previous send was recorded locally.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  callHistory: [] as Row[],
  emailLogs: [] as Row[],
  queries: [] as Array<{ table: string; filters: string[] }>,
  failLookup: false,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const described: string[] = [];
    state.queries.push({ table, filters: described });
    const rows = () => (table === "call_history" ? state.callHistory : state.emailLogs);
    const field = (row: Row, column: string) => {
      const [col, key] = column.split("->>");
      const value = row[col];
      return key ? (value as Row | null)?.[key] : value;
    };
    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        described.push(`${column}=${String(value)}`);
        filters.push((row) => field(row, column) === value);
        return builder;
      },
      or: (expr: string) => {
        described.push(`or:${expr}`);
        filters.push(
          (row) => ["sent", "delivered"].includes(String(row.status)) || row.sent_at != null,
        );
        return builder;
      },
      limit: async () =>
        state.failLookup
          ? { data: null, error: { message: "timeout" } }
          : { data: rows().filter((row) => filters.every((f) => f(row))), error: null },
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("./consent.server", () => ({ getChannelConsentStatus: vi.fn(async () => "granted") }));
// The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));
vi.mock("./email-deliverability.server", () => ({
  augmentEmailHtml: vi.fn(async (html: string) => ({ html })),
  isSuppressed: vi.fn(async () => false),
}));
vi.mock("./shortio.server", () => ({
  prepareTrackedEmailHtml: vi.fn(async (content: string) => ({ content, links: [] })),
  markTrackedDispatchesSent: vi.fn(async () => undefined),
  markTrackedDispatchesFailed: vi.fn(async () => undefined),
}));

import { sendInfobipEmail } from "./email-send.server";
import { callInfobipVoice } from "./infobip-voice.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const KEY = "22222222-2222-4222-8222-222222222222";

function configureInfobip() {
  process.env.INFOBIP_BASE_URL = "https://api.infobip.test";
  process.env.INFOBIP_API_KEY = "test-api-key";
  process.env.INFOBIP_VOICE_FROM = "+551130000000";
  process.env.INFOBIP_VOICE_CALLBACK_TOKEN = "callback-token";
  process.env.PUBLIC_APP_URL = "https://app.example.test";
}

const emailInput = (idempotencyKey?: string) => ({
  to: "destinatario@example.test",
  from: "remetente@example.test",
  subject: "Assunto",
  html: "<p>Oi</p>",
  tenantId: TENANT,
  idempotencyKey,
});

describe("voice and e-mail delivery idempotency (ENV-02)", () => {
  beforeEach(() => {
    state.callHistory.length = 0;
    state.emailLogs.length = 0;
    state.queries.length = 0;
    state.failLookup = false;
    configureInfobip();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of [
      "INFOBIP_BASE_URL",
      "INFOBIP_API_KEY",
      "INFOBIP_VOICE_FROM",
      "INFOBIP_VOICE_CALLBACK_TOKEN",
      "PUBLIC_APP_URL",
    ])
      delete process.env[key];
  });

  it("voice: forwards the stable key as customData and callback correlation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ callId: "call-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callInfobipVoice(
      "+5511999999999",
      { type: "audio", audioUrl: "https://assets.example.test/a.mp3" },
      { idempotencyKey: KEY, tenantId: TENANT },
    );

    expect(result).toMatchObject({ ok: true, idempotencyKey: KEY, providerCallId: "call-1" });
    expect(result.alreadySent).toBeUndefined();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.customData).toBe(KEY);
    expect(body.notifyUrl).toContain(`correlation=${KEY}`);
    expect(state.queries[0]?.filters).toEqual([
      `provider_response->>correlation_id=${KEY}`,
      `tenant_id=${TENANT}`,
    ]);
  });

  it("voice: skips the provider when call_history already has the correlation", async () => {
    state.callHistory.push({
      id: "history-1",
      tenant_id: TENANT,
      provider_call_id: "call-1",
      provider_response: { correlation_id: KEY },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await callInfobipVoice(
      "+5511999999999",
      { type: "audio", audioUrl: "https://assets.example.test/a.mp3" },
      { idempotencyKey: KEY, tenantId: TENANT },
    );

    expect(result).toMatchObject({ ok: true, alreadySent: true, providerCallId: "call-1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voice: fails closed (no call) when the local check cannot run", async () => {
    state.failLookup = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await callInfobipVoice(
      "+5511999999999",
      { type: "tts", text: "Oi" },
      { idempotencyKey: KEY, tenantId: TENANT },
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voice: without a key keeps the old behaviour (fresh key, no lookup)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ callId: "c" }), { status: 200 })),
    );
    const a = await callInfobipVoice("+5511999999999", { type: "tts", text: "Oi" }, { tenantId: TENANT });
    const b = await callInfobipVoice("+5511999999999", { type: "tts", text: "Oi" }, { tenantId: TENANT });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(state.queries).toHaveLength(0);
  });

  it("e-mail: skips the provider when the key was already accepted", async () => {
    state.emailLogs.push({
      id: "email-log-1",
      tenant_id: TENANT,
      status: "sent",
      sent_at: "2026-10-15T10:00:00Z",
      provider_response: { idempotency_key: KEY },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendInfobipEmail(emailInput(KEY));

    expect(result).toMatchObject({ ok: true, alreadySent: true, idempotencyKey: KEY });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("e-mail: a bounced (error, but sent_at set) send also counts as already sent", async () => {
    state.emailLogs.push({
      id: "email-log-2",
      tenant_id: TENANT,
      status: "error",
      sent_at: "2026-10-15T10:00:00Z",
      provider_response: { idempotency_key: KEY },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendInfobipEmail(emailInput(KEY))).toMatchObject({ alreadySent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("e-mail: a temporary failure (pending, never sent) is retried with the same key", async () => {
    state.emailLogs.push({
      id: "email-log-3",
      tenant_id: TENANT,
      status: "pending",
      sent_at: null,
      provider_response: { idempotency_key: KEY },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendInfobipEmail(emailInput(KEY));

    expect(result).toMatchObject({ ok: true, idempotencyKey: KEY });
    expect(result.alreadySent).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get("callbackData")).toBe(KEY);
  });

  it("e-mail: lookup failure is a temporary error and does not send", async () => {
    state.failLookup = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendInfobipEmail(emailInput(KEY))).toMatchObject({ ok: false, temporary: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("e-mail: without a caller key there is no lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );
    await sendInfobipEmail(emailInput(undefined));
    expect(state.queries).toHaveLength(0);
  });
});
