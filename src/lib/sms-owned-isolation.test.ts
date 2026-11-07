// Conta própria de provedor (Task 9): a house's own provider account is
// isolated from everybody else on the same instance.
//   * timeout: OWNED_ACCOUNT_REQUEST_TIMEOUT_MS (8 s) per request; the
//     platform accounts keep their own timeouts.
//   * concurrency: at most OWNED_ACCOUNT_MAX_INFLIGHT requests in flight per
//     owned account; the rest goes back to the queue (429-shaped item
//     backoff: nothing logged, reserved nor sent, no attempt consumed).
//   * breaker: timeouts of an owned account count as failures of THAT
//     account (`sms:<id>`); the global `sms` breaker never moves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
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
const tenantAccess = vi.hoisted(() => () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("@/lib/tenant-access.server", tenantAccess);
vi.mock("./tenant-access.server", tenantAccess);
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
vi.mock("./provider-callback-tokens.server", () => ({
  callbackTokenFor: vi.fn(async (account: { ownerTenantId: string | null }) =>
    account.ownerTenantId ? "pa_test_token" : null,
  ),
}));
vi.mock("./provider-accounts.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-accounts.server")>()),
  resolveSmsAccount: vi.fn(),
  resolveInfobipAccount: vi.fn(),
}));
vi.mock("@/lib/observability/sentry.server", () => ({
  captureServerException: vi.fn(),
  captureServerMessage: vi.fn(),
}));
vi.mock("@/lib/observability/job-monitor.server", () => ({ pingHeartbeat: vi.fn() }));

import {
  resolveInfobipAccount,
  resolveSmsAccount,
  type InfobipAccount,
  type ShortBrasilAccount,
} from "./provider-accounts.server";
import { sendSmsInternal } from "./sms.functions";
import { callInfobipVoice } from "./infobip-voice.server";
import { callInfobipEmail } from "./infobip-email.server";
import { sendInfobipEmail } from "./email-send.server";
import { sendSmsBatch } from "./sms-bulk.server";
import { prepareTrackedEmailHtml, prepareTrackedTextBatch } from "./shortio.server";
import {
  __resetOwnedAccountIsolationForTests,
  OWNED_ACCOUNT_MAX_INFLIGHT,
  OWNED_ACCOUNT_REQUEST_TIMEOUT_MS,
  tryAcquireAccountSlot,
} from "./owned-account-isolation.server";
import {
  __resetOwnedSmsTimeoutsForTests,
  OWNED_SMS_TIMEOUT_BREAKER_THRESHOLD,
  ownedSmsTimeoutCount,
  SmsAccountGates,
} from "./sms-account-gates.server";
import { __resetSmsBreakerCacheForTests } from "./sms-provider-breaker.server";

const HOUSE = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const PLATFORM_SMS = "00000000-0000-4000-8000-00000000aaaa";
const PLATFORM_INFOBIP = "00000000-0000-4000-8000-00000000bbbb";
const OWN_A = "55555555-5555-4555-8555-00000000000a";

function shortBrasil(id: string, ownerTenantId: string | null): ShortBrasilAccount {
  return {
    id,
    provider: "short_brasil",
    label: id,
    ownerTenantId,
    shortcodeToken: `token-${id}`,
    shortcodeUrl: `https://sms.example/${id}/messages`,
    usuario: "",
    chave: "",
    singleUrl: `https://sms.example/${id}/single`,
    bulkUrl: `https://sms.example/${id}/bulk-sms.php`,
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

/** A provider that never answers: only the request's abort signal ends it. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () =>
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError")),
    );
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let hangingHosts: string[];
const fetchesTo = (fragment: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment)).length;
const reservesFor = (tenant: string) =>
  fake.rpcCalls.filter((c) => c.fn === "wallet_reserve" && c.args._tenant === tenant).length;
const breakerReports = () =>
  fake.rpcCalls.filter((c) => c.fn === "provider_breaker_report_failure").map((c) => c.args);

/** Minimal provider_circuit_breakers model: report_failure opens the row it names. */
function installBreakerModel() {
  fake.db.onRpc("provider_breaker_report_failure", (args) => {
    const rows = fake.db.rows("provider_circuit_breakers");
    const backoff = new Date(Date.now() + 120_000).toISOString();
    const now = new Date().toISOString();
    const existing = rows.find((r) => r.channel === args.p_channel);
    if (existing) Object.assign(existing, { state: "open", backoff_until: backoff });
    else
      rows.push({
        channel: args.p_channel,
        state: "open",
        reason: args.p_reason,
        last_error: args.p_error,
        first_opened_at: now,
        backoff_until: backoff,
      });
    return {
      data: [
        {
          state: "open",
          backoff_until: backoff,
          first_opened_at: now,
          open_count: 1,
          opened: !existing,
          alert_due: false,
        },
      ],
      error: null,
    };
  });
  fake.db.onRpc("provider_breaker_acquire", (args) => {
    const row = fake.db.rows("provider_circuit_breakers").find((r) => r.channel === args.p_channel);
    return {
      data: [
        row
          ? {
              decision: "open",
              state: "open",
              reason: row.reason,
              last_error: row.last_error,
              first_opened_at: row.first_opened_at,
              retry_at: row.backoff_until,
            }
          : { decision: "closed", state: "closed" },
      ],
      error: null,
    };
  });
  fake.db.onRpc("provider_breaker_release_probe", () => ({ data: null, error: null }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fake.db.reset();
  fake.rpcCalls.length = 0;
  installCreditLedger(fake.db, { balance: () => 1000 });
  installBreakerModel();
  __resetOwnedAccountIsolationForTests();
  __resetOwnedSmsTimeoutsForTests();
  __resetSmsBreakerCacheForTests();
  vi.mocked(resolveSmsAccount).mockReset();
  vi.mocked(resolveInfobipAccount).mockReset();
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example.test");
  vi.stubEnv("INFOBIP_VOICE_CALLBACK_TOKEN", "callback-token");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  hangingHosts = [];
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (hangingHosts.some((h) => href.includes(h))) return hang(init);
    if (href.includes("/messages")) {
      const body = JSON.parse(String(init?.body ?? "[]")) as Array<{ external_id: string }>;
      return Response.json(body.map((m) => ({ external_id: m.external_id, status: "accepted" })));
    }
    if (href.includes("/sms/2/text/advanced")) {
      return Response.json({
        messages: [{ messageId: "ib-1", status: { groupId: 1, groupName: "PENDING" } }],
      });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const smsSend = (tenantId: string, deliveryKey: string) =>
  sendSmsInternal({ to: "+5511999999999", content: "Oi", tenantId, deliveryKey });

const key = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

/**
 * Lets real async work run (crypto.subtle digests, fake DB) without moving the
 * fake clock: setImmediate is not faked.
 */
async function until(condition: () => boolean, rounds = 500) {
  for (let i = 0; i < rounds && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

/** Settles a promise into a flag so a test can look at it without awaiting. */
function track<T>(promise: Promise<T>) {
  const t = { done: false, value: undefined as T | undefined };
  void promise.then((value) => {
    t.done = true;
    t.value = value;
  });
  return t;
}

describe("(a) conta com dono que nunca responde", () => {
  it.each([
    ["Infobip", () => infobip(OWN_A, HOUSE), OWN_A],
    ["Short Brasil", () => shortBrasil(OWN_A, HOUSE), OWN_A],
  ])("%s: o envio aborta em até 8 s e registra falha da conta", async (_name, account, host) => {
    vi.mocked(resolveSmsAccount).mockResolvedValue(account());
    hangingHosts = [host];

    const send = track(smsSend(HOUSE, key(1)));
    await until(() => fetchesTo(host) === 1);
    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS - 1);
    expect(send.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => send.done);

    expect(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS).toBe(8_000);
    expect(send.value).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(ownedSmsTimeoutCount(OWN_A)).toBe(1);
  });

  it("conta da plataforma (Infobip) mantém o timeout de hoje (15 s)", async () => {
    vi.mocked(resolveSmsAccount).mockResolvedValue(infobip(PLATFORM_INFOBIP, null));
    hangingHosts = [PLATFORM_INFOBIP];

    const send = track(smsSend(OTHER, key(2)));
    await until(() => fetchesTo(PLATFORM_INFOBIP) === 1);
    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    expect(send.done).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000 - OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    await until(() => send.done);
    expect(ownedSmsTimeoutCount(PLATFORM_INFOBIP)).toBe(0);
  });

  it("e-mail e voz de conta com dono também abortam em 8 s", async () => {
    const own = infobip(OWN_A, HOUSE);
    vi.mocked(resolveInfobipAccount).mockResolvedValue(own);
    hangingHosts = [OWN_A];

    const email = track(
      callInfobipEmail({
        to: "a@b.example",
        from: "casa@casa.example",
        subject: "Oi",
        html: "<p>Oi</p>",
        tenantId: HOUSE,
        account: own,
      }),
    );
    const voice = track(
      callInfobipVoice("+5511999999999", { type: "tts", text: "Oi" }, { tenantId: HOUSE }),
    );
    await until(() => fetchesTo(OWN_A) === 2);
    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    await until(() => email.done && voice.done);

    expect(email.value).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
    expect(voice.value).toMatchObject({ ok: false, errorKind: "outcome_unknown" });
  });
});

describe("(b) concorrência por conta com dono", () => {
  it("10 itens pendurados da conta com dono não seguram o item de outra casa no mesmo tick", async () => {
    const own = infobip(OWN_A, HOUSE);
    const platform = shortBrasil(PLATFORM_SMS, null);
    vi.mocked(resolveSmsAccount).mockImplementation(async (tenantId) =>
      tenantId === HOUSE ? own : platform,
    );
    hangingHosts = [OWN_A];

    // One dispatcher tick: a pool of 10 workers (runPool in sms-dispatcher)
    // over 10 items of the house on its own account and 1 of another house.
    const items = [...Array.from({ length: 10 }, (_, i) => HOUSE + ":" + i), OTHER + ":x"];
    const results = new Map<string, Awaited<ReturnType<typeof smsSend>>>();
    let next = 0;
    const pool = track(
      Promise.all(
        Array.from({ length: 10 }, async () => {
          while (next < items.length) {
            const item = items[next++];
            const tenantId = item.split(":")[0];
            results.set(item, await smsSend(tenantId, key(next)));
          }
        }),
      ),
    );

    await until(
      () => results.has(OTHER + ":x") && results.size === 11 - OWNED_ACCOUNT_MAX_INFLIGHT,
    );

    // The other house is done while the owned account is still hanging.
    expect(results.get(OTHER + ":x")).toMatchObject({ ok: true });
    expect(pool.done).toBe(false);
    expect(fetchesTo(OWN_A)).toBe(OWNED_ACCOUNT_MAX_INFLIGHT);
    // Over the limit: back to the queue (429 item backoff), nothing reserved
    // nor logged, no request made.
    const busy = [...results.entries()].filter(([item]) => item.startsWith(HOUSE));
    expect(busy).toHaveLength(10 - OWNED_ACCOUNT_MAX_INFLIGHT);
    for (const [, r] of busy) {
      expect(r).toMatchObject({
        ok: false,
        status: 429,
        temporary: true,
        errorKind: "owned_account_busy",
      });
    }
    expect(reservesFor(HOUSE)).toBe(OWNED_ACCOUNT_MAX_INFLIGHT);
    expect(fake.db.rows("sms_send_logs").filter((r) => r.tenant_id === HOUSE)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    await until(() => pool.done);
    // Slots are given back: the next send of the account reaches the provider.
    hangingHosts = [];
    const after = await smsSend(HOUSE, key(99));
    expect(after).toMatchObject({ ok: true });
  });

  it("conta da plataforma não tem limite de concorrência", async () => {
    vi.mocked(resolveSmsAccount).mockResolvedValue(infobip(PLATFORM_INFOBIP, null));
    hangingHosts = [PLATFORM_INFOBIP];
    const sends = Array.from({ length: 10 }, (_, i) => track(smsSend(OTHER, key(i + 1))));
    await until(() => fetchesTo(PLATFORM_INFOBIP) === 10);
    expect(sends.every((s) => !s.done)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => sends.every((s) => s.done));
  });
});

describe("(c) breaker da conta com dono", () => {
  it("abre sms:<id> depois do limiar de timeouts; o sms global continua fechado", async () => {
    const own = infobip(OWN_A, HOUSE);
    const platform = shortBrasil(PLATFORM_SMS, null);
    vi.mocked(resolveSmsAccount).mockImplementation(async (tenantId) =>
      tenantId === HOUSE ? own : platform,
    );
    hangingHosts = [OWN_A];

    for (let i = 1; i < OWNED_SMS_TIMEOUT_BREAKER_THRESHOLD; i++) {
      const send = track(smsSend(HOUSE, key(i)));
      await until(() => fetchesTo(OWN_A) === i);
      await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
      await until(() => send.done);
    }
    expect(breakerReports()).toHaveLength(0);

    const last = track(smsSend(HOUSE, key(50)));
    await until(() => fetchesTo(OWN_A) === OWNED_SMS_TIMEOUT_BREAKER_THRESHOLD);
    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    await until(() => last.done);

    expect(breakerReports()).toHaveLength(1);
    expect(breakerReports()[0]).toMatchObject({ p_channel: `sms:${OWN_A}`, p_reason: "timeout" });
    expect(breakerReports().some((r) => r.p_channel === "sms")).toBe(false);

    const gates = new SmsAccountGates("test-run");
    expect((await gates.admit(HOUSE, "item-house")).mode).toBe("open");
    expect((await gates.admit(OTHER, "item-other")).mode).toBe("closed");
    // The other house still sends through the platform account.
    expect(await smsSend(OTHER, key(60))).toMatchObject({ ok: true });
  });

  it("uma resposta do provedor zera a contagem de timeouts", async () => {
    vi.mocked(resolveSmsAccount).mockResolvedValue(infobip(OWN_A, HOUSE));
    hangingHosts = [OWN_A];
    for (let i = 1; i < OWNED_SMS_TIMEOUT_BREAKER_THRESHOLD; i++) {
      const send = track(smsSend(HOUSE, key(i)));
      await until(() => fetchesTo(OWN_A) === i);
      await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
      await until(() => send.done);
    }
    hangingHosts = [];
    expect(await smsSend(HOUSE, key(70))).toMatchObject({ ok: true });
    expect(ownedSmsTimeoutCount(OWN_A)).toBe(0);
    hangingHosts = [OWN_A];
    const again = track(smsSend(HOUSE, key(71)));
    await until(() => fetchesTo(OWN_A) === OWNED_SMS_TIMEOUT_BREAKER_THRESHOLD + 1);
    await vi.advanceTimersByTimeAsync(OWNED_ACCOUNT_REQUEST_TIMEOUT_MS);
    await until(() => again.done);
    expect(ownedSmsTimeoutCount(OWN_A)).toBe(1);
    expect(breakerReports()).toHaveLength(0);
  });
});

describe("ocupado = errorKind owned_account_busy, antes de rastrear, reservar ou registrar", () => {
  /** Fills every in-flight slot of the account on this instance. */
  const saturate = (account: { id: string; ownerTenantId: string | null }) =>
    Array.from({ length: OWNED_ACCOUNT_MAX_INFLIGHT }, () => tryAcquireAccountSlot(account)!);
  const walletCalls = () => fake.rpcCalls.filter((c) => c.fn.startsWith("wallet_"));

  it("SMS: sendSmsInternal", async () => {
    const own = infobip(OWN_A, HOUSE);
    vi.mocked(resolveSmsAccount).mockResolvedValue(own);
    const slots = saturate(own);
    const r = await smsSend(HOUSE, key(1));
    expect(r).toMatchObject({
      ok: false,
      status: 429,
      temporary: true,
      errorKind: "owned_account_busy",
    });
    expect(walletCalls()).toHaveLength(0);
    expect(fake.db.rows("sms_send_logs")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    slots.forEach((slot) => slot.release());
    expect(await smsSend(HOUSE, key(2))).toMatchObject({ ok: true });
  });

  it("SMS bulk (Short Brasil legado): nenhum write-ahead nem reserva", async () => {
    const own: ShortBrasilAccount = {
      ...shortBrasil(OWN_A, HOUSE),
      shortcodeToken: "",
      usuario: "u",
      chave: "c",
    };
    vi.mocked(resolveSmsAccount).mockResolvedValue(own);
    saturate(own);
    const result = await sendSmsBatch(
      [1, 2].map((n) => ({
        tenantId: HOUSE,
        to: `+55119${String(10000000 + n).slice(-8)}`,
        content: `Oi ${n}`,
        deliveryKey: key(n),
        playerId: null,
        triggerName: "campanha:Teste",
        linkTrackingEnabled: false,
      })),
    );
    expect(result.outcomes).toEqual([
      expect.objectContaining({ ok: false, retryable: true, errorKind: "owned_account_busy" }),
      expect.objectContaining({ ok: false, retryable: true, errorKind: "owned_account_busy" }),
    ]);
    expect(walletCalls()).toHaveLength(0);
    expect(fake.db.rows("sms_send_logs")).toHaveLength(0);
    expect(prepareTrackedTextBatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("e-mail: sendInfobipEmail", async () => {
    const own = infobip(OWN_A, HOUSE);
    vi.mocked(resolveInfobipAccount).mockResolvedValue(own);
    vi.mocked(prepareTrackedEmailHtml).mockClear();
    saturate(own);
    const r = await sendInfobipEmail({
      to: "jogador@example.test",
      from: "casa@example.test",
      subject: "Oi",
      html: "<p>Oi</p>",
      tenantId: HOUSE,
      idempotencyKey: "email-busy-1",
      linkTracking: {
        tenantId: HOUSE,
        sourceType: "campaign",
        sourceId: "c1",
        recipientPlayerId: null,
        messageLogType: "email_send_logs",
      } as never,
    });
    expect(r).toMatchObject({ ok: false, temporary: true, errorKind: "owned_account_busy" });
    expect(walletCalls()).toHaveLength(0);
    expect(prepareTrackedEmailHtml).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("e-mail: um envio em andamento ocupa um slot só", async () => {
    const own = infobip(OWN_A, HOUSE);
    vi.mocked(resolveInfobipAccount).mockResolvedValue(own);
    fetchMock.mockImplementation(async () => Response.json({ messages: [{ messageId: "m" }] }));
    const slots = Array.from({ length: OWNED_ACCOUNT_MAX_INFLIGHT - 1 }, () =>
      tryAcquireAccountSlot(own)!,
    );
    const r = await sendInfobipEmail({
      to: "jogador@example.test",
      from: "casa@example.test",
      subject: "Oi",
      html: "<p>Oi</p>",
      tenantId: HOUSE,
      idempotencyKey: "email-ok-1",
    });
    expect(r).toMatchObject({ ok: true });
    slots.forEach((slot) => slot.release());
  });

  it("voz: callInfobipVoice", async () => {
    const own = infobip(OWN_A, HOUSE);
    vi.mocked(resolveInfobipAccount).mockResolvedValue(own);
    saturate(own);
    const r = await callInfobipVoice(
      "+5511999999999",
      { type: "tts", text: "Oi" },
      { tenantId: HOUSE },
    );
    expect(r).toMatchObject({ ok: false, status: 429, errorKind: "owned_account_busy" });
    expect(walletCalls()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
