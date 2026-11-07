// Conta própria de provedor (Task 6): every send path tells the reservation
// which provider account WILL send, and that is the very account object the
// send uses (resolved once per send). SQL decides ownership from the id, so
// these tests only check what TS passes: `_provider_account_id` on
// wallet_reserve, the account that actually sent, and how many times the
// resolver ran. Review Focus 1: the house turning its own account on (or it
// becoming unavailable) mid-campaign never splits reservation and send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  // findAcceptedEmail filters with PostgREST `.or(...)`, which the fake DB
  // does not model: no e-mail was accepted before.
  const noAcceptedEmail: any = {
    select: () => noAcceptedEmail,
    eq: () => noAcceptedEmail,
    or: () => noAcceptedEmail,
    limit: async () => ({ data: [], error: null }),
  };
  return {
    supabaseAdmin: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        fake.rpcCalls.push({ fn, args });
        return fake.db.client.rpc(fn, args);
      },
      from: (table: string) =>
        table === "email_send_logs" ? noAcceptedEmail : fake.db.client.from(table),
    },
  };
});
vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("./tenant-access.server", () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("./consent.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./consent.server")>()),
  isChannelRevoked: vi.fn(async () => false),
  getChannelConsentStatus: vi.fn(async () => null),
}));
vi.mock("./tenant-channels.server", () => ({ isChannelEnabled: vi.fn(async () => true) }));
vi.mock("./email-deliverability.server", () => ({
  augmentEmailHtml: vi.fn(async (html: string) => ({ html, unsubscribeUrl: null })),
  isSuppressed: vi.fn(async () => false),
}));
vi.mock("./shortio.server", () => ({
  prepareTrackedText: vi.fn(async (content: string) => ({ content, links: [] })),
  prepareTrackedTextBatch: vi.fn(async (items: Array<{ content: string }>) =>
    items.map((i) => ({ ok: true, content: i.content, links: [] })),
  ),
  prepareTrackedEmailHtml: vi.fn(async (content: string) => ({ content, links: [] })),
  markTrackedDispatchesSent: vi.fn(async () => undefined),
  markTrackedDispatchesFailed: vi.fn(async () => undefined),
}));
vi.mock("./provider-accounts.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-accounts.server")>()),
  resolveSmsAccount: vi.fn(),
  resolveInfobipAccount: vi.fn(),
}));

import {
  ProviderAccountUnavailableError,
  resolveInfobipAccount,
  resolveSmsAccount,
  type InfobipAccount,
  type ShortBrasilAccount,
} from "./provider-accounts.server";
import { sendSmsInternal } from "./sms.functions";
import { sendSmsBatch, type SmsBatchItem } from "./sms-bulk.server";
import { callInfobipVoice } from "./infobip-voice.server";
import { sendInfobipEmail } from "./email-send.server";

const HOUSE = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const PLATFORM_SMS = "00000000-0000-4000-8000-00000000aaaa";
const OWN_A = "55555555-5555-4555-8555-00000000000a";
const OWN_B = "55555555-5555-4555-8555-00000000000b";

function shortBrasil(id: string, over: Partial<ShortBrasilAccount> = {}): ShortBrasilAccount {
  return {
    id,
    provider: "short_brasil",
    label: id,
    ownerTenantId: null,
    shortcodeToken: `token-${id}`,
    shortcodeUrl: `https://sms.example/${id}/messages`,
    usuario: "",
    chave: "",
    singleUrl: `https://sms.example/${id}/single`,
    bulkUrl: `https://sms.example/${id}/bulk-sms.php`,
    ...over,
  };
}

function infobip(id: string, ownerTenantId: string | null): InfobipAccount {
  return {
    id,
    provider: "infobip",
    label: id,
    ownerTenantId,
    baseUrl: `https://${id}.infobip.example`,
    apiKey: `key-${id}`,
    voiceFrom: "551130000000",
    smsFrom: "",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));
const reserves = () => fake.rpcCalls.filter((c) => c.fn === "wallet_reserve").map((c) => c.args);

beforeEach(() => {
  fake.db.reset();
  fake.rpcCalls.length = 0;
  installCreditLedger(fake.db, { balance: () => 1000 });
  vi.mocked(resolveSmsAccount).mockReset();
  vi.mocked(resolveInfobipAccount).mockReset();
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example.test");
  vi.stubEnv("INFOBIP_VOICE_CALLBACK_TOKEN", "callback-token");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("bulk-sms.php")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        bulk: Array<{ parceiroId: string }>;
      };
      return Response.json({
        id: "lote-1",
        bulk: body.bulk.map((b, i) => ({ id: `msg-${i + 1}`, parceiroId: b.parceiroId })),
      });
    }
    if (href.includes("/messages")) {
      const body = JSON.parse(String(init?.body ?? "[]")) as Array<{ external_id: string }>;
      return Response.json(body.map((m) => ({ external_id: m.external_id, status: "accepted" })));
    }
    if (href.includes("/markuplanguage/")) return Response.json({ callId: "call-1" });
    if (href.includes("/email/3/send")) return Response.json({ messages: [{ messageId: "m-1" }] });
    throw new Error(`unexpected fetch ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const smsSend = (deliveryKey: string) =>
  sendSmsInternal({
    to: "+5511999999999",
    content: "Oi",
    tenantId: HOUSE,
    deliveryKey,
  });

describe("SMS single send", () => {
  it("sendSmsInternal reserva e envia com a mesma conta", async () => {
    const a = shortBrasil(OWN_A, { ownerTenantId: HOUSE });
    const b = shortBrasil(OWN_B);
    vi.mocked(resolveSmsAccount).mockResolvedValueOnce(a).mockResolvedValueOnce(b);

    const result = await smsSend("11111111-1111-4111-8111-000000000001");

    expect(result.ok).toBe(true);
    expect(resolveSmsAccount).toHaveBeenCalledTimes(1);
    expect(reserves()).toHaveLength(1);
    expect(reserves()[0]).toMatchObject({ _tenant: HOUSE, _provider_account_id: OWN_A });
    expect(fetchedUrls()).toEqual([a.shortcodeUrl]);
    expect(fake.db.rows("sms_send_logs")[0]).toMatchObject({ provider_account_id: OWN_A });
  });

  it("conta da casa indisponível: nada reservado, nada enviado", async () => {
    vi.mocked(resolveSmsAccount).mockRejectedValue(
      new ProviderAccountUnavailableError("Conta SMS da casa indisponível"),
    );

    const result = await smsSend("11111111-1111-4111-8111-000000000002");

    expect(result).toMatchObject({ ok: false, errorKind: "misconfigured" });
    expect(resolveSmsAccount).toHaveBeenCalledTimes(1);
    expect(reserves()).toHaveLength(0);
    expect(fake.rpcCalls.filter((c) => c.fn === "wallet_refund")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const logs = fake.db.rows("sms_send_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      tenant_id: HOUSE,
      error: expect.stringContaining("Conta SMS da casa indisponível"),
      billed_units: null,
      provider_account_id: null,
    });
    expect(logs[0].provider_response).toMatchObject({ credit_reserved: false });
  });
});

describe("SMS bulk", () => {
  const item = (n: number, tenantId: string): SmsBatchItem => ({
    tenantId,
    to: `+55119${String(10000000 + n).slice(-8)}`,
    content: `Oi ${n}`,
    deliveryKey: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
    playerId: null,
    triggerName: "campanha:Teste",
    linkTrackingEnabled: false,
  });

  it("bulk agrupa por conta e reserva com a conta do grupo", async () => {
    const legacy = { shortcodeToken: "", usuario: "u", chave: "c" };
    const platform = shortBrasil(PLATFORM_SMS, legacy);
    const own = shortBrasil(OWN_B, { ...legacy, ownerTenantId: OTHER });
    // A second resolution would flip the accounts: the batch must not re-resolve.
    vi.mocked(resolveSmsAccount).mockImplementation(async (tenantId) => {
      const calls = vi.mocked(resolveSmsAccount).mock.calls.filter(([t]) => t === tenantId).length;
      if (tenantId === OTHER) return calls === 1 ? own : platform;
      return calls === 1 ? platform : own;
    });

    const result = await sendSmsBatch([item(1, HOUSE), item(2, OTHER), item(3, HOUSE)]);

    expect(result.outcomes.map((o) => o.ok)).toEqual([true, true, true]);
    expect(resolveSmsAccount).toHaveBeenCalledTimes(2);
    const byTenant = (t: string) => reserves().filter((r) => r._tenant === t);
    expect(byTenant(HOUSE)).toHaveLength(2);
    expect(byTenant(HOUSE).every((r) => r._provider_account_id === PLATFORM_SMS)).toBe(true);
    expect(byTenant(OTHER)).toHaveLength(1);
    expect(byTenant(OTHER)[0]).toMatchObject({ _provider_account_id: OWN_B });
    expect(fetchedUrls().sort()).toEqual([own.bulkUrl, platform.bulkUrl].sort());
    const logs = fake.db.rows("sms_send_logs");
    for (const log of logs)
      expect(log.provider_account_id).toBe(log.tenant_id === OTHER ? OWN_B : PLATFORM_SMS);
  });
});

describe("voz e e-mail", () => {
  it("voz e e-mail reservam com a conta resolvida", async () => {
    const own = infobip(OWN_A, HOUSE);
    const other = infobip(OWN_B, null);
    vi.mocked(resolveInfobipAccount).mockResolvedValueOnce(own).mockResolvedValueOnce(other);
    const voice = await callInfobipVoice(
      "+5511999999999",
      { type: "tts", text: "Oi", language: "pt" },
      { tenantId: HOUSE, idempotencyKey: "voice-key-1" },
    );
    expect(voice.ok).toBe(true);
    expect(voice.providerAccountId).toBe(OWN_A);
    expect(reserves()).toHaveLength(1);
    expect(reserves()[0]).toMatchObject({ _item: "voice_30s", _provider_account_id: OWN_A });
    expect(fetchedUrls()).toEqual([`${own.baseUrl}/markuplanguage/1/create`]);

    fake.rpcCalls.length = 0;
    fetchMock.mockClear();
    vi.mocked(resolveInfobipAccount).mockReset();
    vi.mocked(resolveInfobipAccount).mockResolvedValueOnce(own).mockResolvedValueOnce(other);
    const email = await sendInfobipEmail({
      to: "jogador@example.test",
      from: "casa@example.test",
      subject: "Oi",
      html: "<p>Oi</p>",
      tenantId: HOUSE,
      idempotencyKey: "email-key-1",
    });
    expect(email.ok).toBe(true);
    expect(email.providerAccountId).toBe(OWN_A);
    expect(resolveInfobipAccount).toHaveBeenCalledTimes(1);
    expect(reserves()).toHaveLength(1);
    expect(reserves()[0]).toMatchObject({ _item: "email", _provider_account_id: OWN_A });
    expect(fetchedUrls()).toEqual([`${own.baseUrl}/email/3/send`]);
  });

  it("e-mail com a conta da casa indisponível: nada reservado, nada enviado", async () => {
    vi.mocked(resolveInfobipAccount).mockRejectedValue(
      new ProviderAccountUnavailableError("Conta de e-mail da casa indisponível"),
    );
    const email = await sendInfobipEmail({
      to: "jogador@example.test",
      from: "casa@example.test",
      subject: "Oi",
      html: "<p>Oi</p>",
      tenantId: HOUSE,
      idempotencyKey: "email-key-2",
    });
    expect(email).toMatchObject({ ok: false, errorKind: "misconfigured", providerAccountId: null });
    expect(email.billing).toBeUndefined();
    expect(fake.rpcCalls.filter((c) => c.fn.startsWith("wallet_"))).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
