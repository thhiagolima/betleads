// ENV-10 — Short Brasil bulk sends with per-recipient text and tracked links.
// Runs the real sendSmsBatch, prepareTrackedTextBatch, findAcceptedDeliveryKeys,
// credit reservation and the real sms-webhook route against an in-memory
// database and mocked fetch (no real SMS / Short.io calls).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantCanOperate: vi.fn(async () => undefined),
  // The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
  assertTenantCanSendExternally: vi.fn(async () => undefined),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
  demoSendBlockedReason: vi.fn(async () => null),
  resolveCurrentTenantId: vi.fn(),
  resolveOperationalTenantId: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

import {
  reconcileStaleSubmittingLogs,
  sendSmsBatch,
  smsBulkEnabled,
  SmsBatchDeferredError,
  type SmsBatchItem,
} from "./sms-bulk.server";
import { Route as SmsWebhookRoute } from "@/routes/api/public/sms-webhook";
import { assertTenantNotDemoForSend } from "@/lib/tenant-access.server";
import { BILLING_LOCKED_TEXT, TenantBillingLockedError } from "@/lib/billing/billing-locked-error";
import { __resetShortenerDomainCacheForTests } from "./shortio.server";
import {
  __resetProviderAccountsCacheForTests,
  DEFAULT_SHORT_BRASIL_ACCOUNT_ID,
} from "./provider-accounts.server";
import { encryptProviderCredentials } from "./secret-box.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const key = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const player = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

function item(n: number, over: Partial<SmsBatchItem> = {}): SmsBatchItem {
  return {
    tenantId: TENANT,
    to: `+55119${String(10000000 + n).slice(-8)}`,
    content: `Oi Jogador ${n}, sua oferta: https://casa.example/promo`,
    deliveryKey: key(n),
    playerId: player(n),
    triggerName: "campanha:Teste:iGaming",
    linkTrackingEnabled: true,
    linkTrackingOrigin: { sourceType: "campaign", sourceId: CAMPAIGN },
    ...over,
  };
}

type SmsBody = { bulk: Array<{ celular: string; mensagem: string; parceiroId: string }> };
type Behaviour = (body: SmsBody) => Response | Promise<Response>;

let smsBehaviour: Behaviour;
let shortioBehaviour: (links: Array<{ originalURL: string }>) => Response;
const smsCalls: SmsBody[] = [];
const shortioCalls: Array<{ links: Array<{ originalURL: string }> }> = [];
let budgetCalls: Array<{ channel: string; n: number }> = [];
let credits: ReturnType<typeof installCreditLedger>;

const acceptAll: Behaviour = (body) =>
  Response.json({
    id: "lote-1",
    bulk: body.bulk.map((b, i) => ({ id: `msg-${i + 1}`, parceiroId: b.parceiroId })),
  });

function shortioOk(links: Array<{ originalURL: string }>) {
  return Response.json(
    links.map((l, i) => ({
      idString: `lnk_${shortioCalls.length}_${i}`,
      shortURL: `https://go.example/s${shortioCalls.length}x${i}`,
      originalURL: l.originalURL,
    })),
  );
}

function installFetch() {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (href.startsWith("https://api.short.io/links/bulk")) {
      shortioCalls.push(body);
      return shortioBehaviour(body.links);
    }
    if (href.includes("bulk-sms.php")) {
      smsCalls.push(body);
      return smsBehaviour(body);
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function settings(fallback: "block" | "passthrough") {
  fake.db.rows("shortio_settings").push({
    tenant_id: TENANT,
    enabled: true,
    domain: "go.example",
    fallback_mode: fallback,
    default_ttl_days: null,
    allowed_destination_hosts: [],
    enabled_channels: ["sms", "email"],
  });
  // The shortener domain comes from tenant_domains (the migration backfilled
  // shortio_settings.domain as the verified default).
  if (!fake.db.rows("tenant_domains").some((d) => d.tenant_id === TENANT))
    fake.db.rows("tenant_domains").push({
      id: "44444444-4444-4444-8444-444444444444",
      tenant_id: TENANT,
      kind: "shortener",
      hostname: "go.example",
      status: "verified",
      is_default: true,
      removed_at: null,
    });
}

const logs = () => fake.db.rows("sms_send_logs");
const logFor = (k: string) => logs().filter((l) => l.idempotency_key === k);

describe("sendSmsBatch (ENV-10, Short Brasil bulk)", () => {
  beforeEach(() => {
    fake.db.reset();
    __resetShortenerDomainCacheForTests();
    credits = installCreditLedger(fake.db);
    budgetCalls = [];
    fake.db.onRpc("consume_channel_budget", (args) => {
      budgetCalls.push({ channel: String(args.p_channel), n: Number(args.p_n) });
      return { data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }], error: null };
    });
    smsCalls.length = 0;
    shortioCalls.length = 0;
    smsBehaviour = acceptAll;
    shortioBehaviour = shortioOk;
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "");
    vi.stubEnv("SHORT_BRASIL_SMS_USUARIO", "user");
    vi.stubEnv("SHORT_BRASIL_SMS_CHAVE", "key");
    vi.stubEnv("SHORTIO_API_KEY", "shortio-test-key");
    vi.stubEnv("CLICK_TRACKING_SECRET", "x".repeat(40));
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
    vi.stubEnv("SHORT_BRASIL_WEBHOOK_SECRET", "hook-secret");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("one HTTP call, personalised text and one tracked short link per recipient, mapped by parceiroId", async () => {
    settings("block");
    const items = [item(1), item(2), item(3)];
    const r = await sendSmsBatch(items);

    expect(smsCalls).toHaveLength(1);
    expect(shortioCalls).toHaveLength(1); // 3 links in one Short.io bulk call
    expect(shortioCalls[0].links).toHaveLength(3);
    expect(budgetCalls.filter((b) => b.channel === "shortio")).toEqual([{ channel: "shortio", n: 1 }]);

    const sent = smsCalls[0].bulk;
    expect(sent.map((b) => b.parceiroId)).toEqual(items.map((i) => i.deliveryKey));
    expect(sent[0].mensagem).toMatch(/^Oi Jogador 1, sua oferta: https:\/\/go\.example\/\S+$/);
    expect(new Set(sent.map((b) => b.mensagem.split(" ").pop())).size).toBe(3);
    expect(sent[0].celular).toBe("11910000001");

    expect(r.outcomes.map((o) => o.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(r.lotes).toEqual(["lote-1"]);
    items.forEach((it, i) => {
      const [log] = logFor(it.deliveryKey);
      expect(log).toMatchObject({
        status: "sent",
        delivery_status: "sent",
        provider: "short-brasil",
        provider_message_id: `msg-${i + 1}`,
        player_id: it.playerId,
        tenant_id: TENANT,
      });
      const dispatches = fake.db
        .rows("link_dispatches")
        .filter((d) => d.idempotency_key === `${it.deliveryKey}:0`);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        message_log_id: log.id,
        source_type: "campaign",
        source_id: CAMPAIGN,
        recipient_player_id: it.playerId,
        send_status: "sent",
      });
    });
    expect(credits.charged()).toBe(3);
    expect(credits.ledger().map((l) => l.idempotency_key)).toContain(
      `sms-reserve:delivery:${key(1)}`,
    );
  });

  it("a house locked for the monthly fee: its items fail final (not retryable), nothing written or charged; other houses still send", async () => {
    settings("block");
    const LOCKED = "00000000-0000-4000-8000-0000000000ff";
    const guard = vi.mocked(assertTenantNotDemoForSend);
    guard.mockImplementation(async (tenantId) => {
      if (tenantId === LOCKED) throw new TenantBillingLockedError();
    });
    try {
      const r = await sendSmsBatch([item(1, { tenantId: LOCKED }), item(2), item(3, { tenantId: LOCKED })]);

      for (const index of [0, 2]) {
        expect(r.outcomes[index]).toMatchObject({
          status: "failed",
          ok: false,
          retryable: false,
          error: BILLING_LOCKED_TEXT,
        });
      }
      expect(r.outcomes[1]).toMatchObject({ status: "accepted", ok: true });
      expect(smsCalls).toHaveLength(1);
      expect(smsCalls[0].bulk.map((b) => b.parceiroId)).toEqual([key(2)]);
      expect(logFor(key(1))).toHaveLength(0);
      expect(logFor(key(3))).toHaveLength(0);
      expect(credits.charged()).toBe(1);
    } finally {
      guard.mockImplementation(async () => undefined);
    }
  });

  it("a whole batch of a locked house: nothing is sent and no item is retryable", async () => {
    const guard = vi.mocked(assertTenantNotDemoForSend);
    guard.mockImplementation(async () => {
      throw new TenantBillingLockedError();
    });
    try {
      const r = await sendSmsBatch([item(1), item(2)]);
      expect(r.outcomes.every((o) => !o.ok && o.retryable === false)).toBe(true);
      expect(smsCalls).toHaveLength(0);
      expect(logs()).toHaveLength(0);
      expect(credits.charged()).toBe(0);
    } finally {
      guard.mockImplementation(async () => undefined);
    }
  });

  it("partial rejection: only the items missing from bulk[] fail and are refunded", async () => {
    settings("block");
    smsBehaviour = (body) =>
      Response.json({
        id: "lote-2",
        bulk: body.bulk
          .filter((b) => b.parceiroId !== key(2))
          .map((b, i) => ({ id: `m${i}`, parceiroId: b.parceiroId })),
      });
    const r = await sendSmsBatch([item(1), item(2), item(3)]);

    expect(r.outcomes.map((o) => o.status)).toEqual(["accepted", "rejected", "accepted"]);
    expect(r.outcomes[1]).toMatchObject({ ok: false, retryable: false });
    expect(logFor(key(2))[0]).toMatchObject({ status: "error", delivery_status: "failed" });
    expect(logFor(key(1))[0]).toMatchObject({ status: "sent", delivery_status: "sent" });
    expect(credits.charged()).toBe(2);
    expect(credits.ledger().some((l) => l.idempotency_key === `sms-refund:delivery:${key(2)}`)).toBe(true);
    const failedDispatch = fake.db
      .rows("link_dispatches")
      .find((d) => d.idempotency_key === `${key(2)}:0`);
    expect(failedDispatch?.send_status).toBe("failed");
  });

  it("timeout after the request left: no retry, kept as pending confirmation, never resent", async () => {
    settings("block");
    smsBehaviour = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    };
    const items = [item(1), item(2)];
    const first = await sendSmsBatch(items);

    expect(smsCalls).toHaveLength(1); // never resent inside the module
    expect(first.outcomes.map((o) => o.status)).toEqual([
      "pending_confirmation",
      "pending_confirmation",
    ]);
    expect(first.outcomes[0]).toMatchObject({ ok: true, errorKind: "outcome_unknown" });
    expect(logFor(key(1))[0]).toMatchObject({ status: "sent", delivery_status: "unconfirmed" });
    expect(credits.charged()).toBe(2); // possibly sent: not refunded

    // Next run (worker retry / crash recovery): nothing reaches the provider.
    smsBehaviour = acceptAll;
    const second = await sendSmsBatch(items);
    expect(smsCalls).toHaveLength(1);
    expect(second.outcomes.map((o) => o.status)).toEqual(["already_sent", "already_sent"]);
    expect(credits.charged()).toBe(2);
  });

  it("a 5xx is treated as outcome unknown (not resent)", async () => {
    settings("block");
    smsBehaviour = () => new Response("<html>bad gateway</html>", { status: 502 });
    const r = await sendSmsBatch([item(1)]);
    expect(smsCalls).toHaveLength(1);
    expect(r.outcomes[0].status).toBe("pending_confirmation");
  });

  it("not_sent (connection refused): retried, then the whole chunk fails retryable and is refunded", async () => {
    settings("block");
    smsBehaviour = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    };
    const items = [item(1), item(2)];
    const r = await sendSmsBatch(items);
    expect(smsCalls).toHaveLength(3);
    expect(r.outcomes.every((o) => o.status === "failed" && o.retryable)).toBe(true);
    expect(credits.charged()).toBe(0);
    expect(logFor(key(1))[0]).toMatchObject({ status: "error", delivery_status: "failed" });

    // Later resend is charged once more under the next billing generation.
    smsBehaviour = acceptAll;
    const retry = await sendSmsBatch(items);
    expect(retry.outcomes.map((o) => o.status)).toEqual(["accepted", "accepted"]);
    expect(credits.charged()).toBe(2);
    expect(credits.ledger().map((l) => l.idempotency_key)).toContain(
      `sms-reserve:delivery:${key(1)}:1`,
    );
  }, 15_000);

  it("request-level 505 (provider balance): whole chunk failed, retryable, refunded", async () => {
    settings("block");
    smsBehaviour = () => Response.json({ status: 505, detalhe: "saldo insuficiente" });
    const r = await sendSmsBatch([item(1), item(2)]);
    expect(r.outcomes.every((o) => o.status === "failed" && o.retryable && o.insufficientFunds)).toBe(true);
    expect(credits.charged()).toBe(0);
  });

  it("request-level 101 (incident 15/10: route without balance): provider_account, refunded, breaker opened", async () => {
    settings("block");
    const reports: Array<Record<string, unknown>> = [];
    fake.db.onRpc("provider_breaker_report_failure", (args) => {
      reports.push(args);
      return { data: [{ state: "open", opened: true, open_count: 1, alert_due: false }], error: null };
    });
    smsBehaviour = () => Response.json({ status: 101, statusDetalhe: "Erro de Autenticação" });
    const r = await sendSmsBatch([item(1), item(2)]);
    expect(
      r.outcomes.every((o) => o.status === "failed" && o.retryable && o.errorKind === "provider_account"),
    ).toBe(true);
    expect(credits.charged()).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ p_channel: "sms", p_reason: "auth" });
  });

  it("per-item 101/505 in bulk[] is retryable provider_account; a real per-item rejection stays final", async () => {
    settings("block");
    fake.db.onRpc("provider_breaker_report_failure", () => ({
      data: [{ state: "open", opened: true, open_count: 1, alert_due: false }],
      error: null,
    }));
    smsBehaviour = (body) =>
      Response.json({
        id: "lote-9",
        bulk: body.bulk.map((b, i) =>
          i === 0
            ? { id: "msg-1", parceiroId: b.parceiroId }
            : i === 1
              ? { parceiroId: b.parceiroId, status: 505, statusDetalhe: "Saldo insuficiente" }
              : { parceiroId: b.parceiroId, status: 303, statusDetalhe: "Numero invalido" },
        ),
      });
    const r = await sendSmsBatch([item(1), item(2), item(3)]);
    expect(r.outcomes[0]).toMatchObject({ status: "accepted", ok: true });
    expect(r.outcomes[1]).toMatchObject({ status: "failed", retryable: true, errorKind: "provider_account" });
    expect(r.outcomes[2]).toMatchObject({ status: "rejected", retryable: false });
    expect(credits.charged()).toBe(1);
  });

  it("status 5 'Saldo insuficiente' (incident 27-28/10/2026): request-level and per item are provider_account", async () => {
    settings("block");
    const reports: Array<Record<string, unknown>> = [];
    fake.db.onRpc("provider_breaker_report_failure", (args) => {
      reports.push(args);
      return { data: [{ state: "open", opened: true, open_count: 1, alert_due: false }], error: null };
    });
    smsBehaviour = () => Response.json({ status: 5, statusDetalhe: "Saldo insuficiente" });
    const whole = await sendSmsBatch([item(1)]);
    expect(whole.outcomes[0]).toMatchObject({ status: "failed", retryable: true, errorKind: "provider_account" });
    expect(reports[0]).toMatchObject({ p_reason: "no_balance" });

    smsBehaviour = (body) =>
      Response.json({
        id: "lote-5",
        bulk: body.bulk.map((b, i) =>
          i === 0
            ? { id: "msg-2", parceiroId: b.parceiroId }
            : { parceiroId: b.parceiroId, status: 5, statusDetalhe: "Saldo insuficiente" },
        ),
      });
    const perItem = await sendSmsBatch([item(2), item(3)]);
    expect(perItem.outcomes[0]).toMatchObject({ status: "accepted", ok: true });
    expect(perItem.outcomes[1]).toMatchObject({ status: "failed", retryable: true, errorKind: "provider_account" });
    expect(credits.charged()).toBe(1);
  });

  it("an unknown request-level code without an id is a final rejection, not outcome unknown", async () => {
    settings("block");
    smsBehaviour = () => Response.json({ status: 7, statusDetalhe: "Algo novo" });
    const r = await sendSmsBatch([item(1)]);
    expect(r.outcomes[0]).toMatchObject({ status: "failed", retryable: false });
    expect(credits.charged()).toBe(0);
  });

  describe("per-house SMS accounts", () => {
    const OTHER = "00000000-0000-4000-8000-0000000000aa";
    const OWN_ACCOUNT = "55555555-5555-4555-8555-555555555555";

    async function giveOtherHouseOwnAccount(status = "active") {
      vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
      fake.db.rows("provider_accounts").push({
        id: OWN_ACCOUNT,
        provider: "short_brasil",
        label: "Short Brasil casa AA",
        channels: ["sms"],
        credentials_source: "db",
        credentials_encrypted: await encryptProviderCredentials({ usuario: "own-user", chave: "own-key" }),
        config: { bulk_url: "https://own.example.test/bot/bulk-sms.php" },
        status,
      });
      fake.db.rows("tenant_channel_providers").push({
        tenant_id: OTHER,
        channel: "sms",
        provider_account_id: OWN_ACCOUNT,
      });
      __resetProviderAccountsCacheForTests();
    }

    const bulkRequests = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes("bulk-sms.php"))
        .map(([url, init]) => ({
          url: String(url),
          usuario: (init?.headers as Record<string, string>).usuario,
          parceiroIds: (JSON.parse(String(init?.body)) as SmsBody).bulk.map((b) => b.parceiroId),
        }));

    afterEach(() => __resetProviderAccountsCacheForTests());

    it("houses on different accounts go out in separate requests, each with its own credentials", async () => {
      settings("block");
      await giveOtherHouseOwnAccount();
      const other = { tenantId: OTHER, linkTrackingEnabled: false };
      const r = await sendSmsBatch([item(1), item(2, other), item(3), item(4, other)]);

      expect(r.outcomes.map((o) => o.status)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
      expect(bulkRequests()).toEqual([
        {
          url: "http://lp01-short.painelsms.com/bot/bulk-sms.php",
          usuario: "user",
          parceiroIds: [key(1), key(3)],
        },
        {
          url: "https://own.example.test/bot/bulk-sms.php",
          usuario: "own-user",
          parceiroIds: [key(2), key(4)],
        },
      ]);
      expect(logFor(key(1))[0].provider_account_id).toBe(DEFAULT_SHORT_BRASIL_ACCOUNT_ID);
      expect(logFor(key(2))[0].provider_account_id).toBe(OWN_ACCOUNT);
    });

    it("a house whose own account is disabled fails retryable, never via the platform account", async () => {
      settings("block");
      await giveOtherHouseOwnAccount("disabled");
      const r = await sendSmsBatch([item(1), item(2, { tenantId: OTHER, linkTrackingEnabled: false })]);

      expect(r.outcomes[0]).toMatchObject({ status: "accepted" });
      expect(r.outcomes[1]).toMatchObject({
        status: "failed",
        retryable: true,
        errorKind: "misconfigured",
      });
      expect(bulkRequests().map((b) => b.parceiroIds)).toEqual([[key(1)]]);
      expect(logFor(key(2))).toHaveLength(0);
      expect(credits.charged()).toBe(1);
    });
  });

  it("missing credentials: nothing logged, charged or sent", async () => {
    vi.stubEnv("SHORT_BRASIL_SMS_USUARIO", "");
    const r = await sendSmsBatch([item(1)]);
    expect(r.outcomes[0]).toMatchObject({ status: "failed", retryable: true, errorKind: "misconfigured" });
    expect(smsCalls).toHaveLength(0);
    expect(credits.charged()).toBe(0);
    expect(logs()).toHaveLength(0);
  });

  it("insufficient internal credits fail only the uncovered items", async () => {
    fake.db.reset();
    credits = installCreditLedger(fake.db, { balance: () => 1 });
    fake.db.onRpc("consume_channel_budget", (args) => ({
      data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }],
      error: null,
    }));
    const r = await sendSmsBatch([item(1, { linkTrackingEnabled: false }), item(2, { linkTrackingEnabled: false })]);
    expect(r.outcomes.filter((o) => o.status === "accepted")).toHaveLength(1);
    expect(r.outcomes.filter((o) => o.status === "failed")).toHaveLength(1);
    expect(smsCalls[0].bulk).toHaveLength(1);
    expect(credits.charged()).toBe(1);
  });

  it("revoked consent and invalid phones are skipped and logged without charge", async () => {
    fake.db.rows("channel_consents").push({
      tenant_id: TENANT,
      channel: "sms",
      subject: "5511910000002",
      status: "revoked",
    });
    const r = await sendSmsBatch([item(1), item(2), item(3, { to: "123" })]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["accepted", "failed", "failed"]);
    expect(r.outcomes[1].suppressed).toBe(true);
    expect(smsCalls[0].bulk.map((b) => b.parceiroId)).toEqual([key(1)]);
    expect(credits.charged()).toBe(1);
  });

  it("Short.io bulk failure + passthrough: sends the first-party redirect, still tracked", async () => {
    settings("passthrough");
    shortioBehaviour = () => new Response("down", { status: 503 });
    const r = await sendSmsBatch([item(1), item(2)]);

    expect(shortioCalls).toHaveLength(3); // retried, then fell back
    expect(r.outcomes.map((o) => o.status)).toEqual(["accepted", "accepted"]);
    for (const b of smsCalls[0].bulk)
      expect(b.mensagem).toMatch(/https:\/\/app\.example\/api\/public\/click\/[0-9a-f-]{36}\?s=/);
    const tracked = fake.db.rows("tracked_links");
    expect(tracked).toHaveLength(2);
    expect(tracked.every((t) => t.status === "failed")).toBe(true); // excluded from Short.io sync
    expect(fake.db.rows("link_dispatches")).toHaveLength(2);
  }, 10_000);

  it("Short.io bulk failure + block: batch deferred before any charge or send", async () => {
    settings("block");
    shortioBehaviour = () => new Response("bad", { status: 400 });
    await expect(sendSmsBatch([item(1), item(2)])).rejects.toBeInstanceOf(SmsBatchDeferredError);
    expect(smsCalls).toHaveLength(0);
    expect(credits.charged()).toBe(0);
    expect(logs()).toHaveLength(0);
  });

  it("chunks at 500 items per HTTP request", async () => {
    const items = Array.from({ length: 1_200 }, (_, i) => item(i + 1, { linkTrackingEnabled: false }));
    const r = await sendSmsBatch(items);
    expect(smsCalls.map((c) => c.bulk.length)).toEqual([500, 500, 200]);
    expect(r.httpCalls).toBe(3);
    expect(r.outcomes.every((o) => o.status === "accepted")).toBe(true);
  }, 20_000);

  it("callbacks (bulk lote by provider id, single GET by parceiroId) match bulk-sent rows", async () => {
    settings("block");
    const r = await sendSmsBatch([item(1)]);
    expect(r.outcomes[0].status).toBe("accepted");
    // A second delivery whose outcome is unknown (no provider id stored).
    smsBehaviour = () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await sendSmsBatch([item(2)]);
    expect(logFor(key(2))[0].delivery_status).toBe("unconfirmed");

    const handlers = (
      SmsWebhookRoute as unknown as {
        options: {
          server: {
            handlers: {
              GET: (i: { request: Request }) => Promise<Response>;
              POST: (i: { request: Request }) => Promise<Response>;
            };
          };
        };
      }
    ).options.server.handlers;
    const post = await handlers.POST({
      request: new Request("https://app.example/api/public/sms-webhook?token=hook-secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lote: [{ id: "msg-1", parceiroId: key(1), statusConfirmacao: "CONFIRMADO" }],
        }),
      }),
    });
    expect(await post.json()).toMatchObject({ processed: 1, matched: 1 });
    const get = await handlers.GET({
      request: new Request(
        `https://app.example/api/public/sms-webhook?token=hook-secret&parceiroId=${key(2)}&statusConfirmacao=CONFIRMADO`,
      ),
    });
    expect(await get.json()).toMatchObject({ processed: 1, matched: 1 });

    expect(logFor(key(1))[0].delivery_status).toBe("delivered");
    expect(logFor(key(2))[0].delivery_status).toBe("delivered");
    expect(logs().some((l) => l.trigger_name === "callback-orphan")).toBe(false);
    const dispatch = fake.db.rows("link_dispatches").find((d) => d.idempotency_key === `${key(1)}:0`);
    expect(dispatch?.delivery_status).toBe("delivered");

    // Every callback is kept raw: body byte for byte, our token out of the query.
    const raw = fake.db.rows("sms_callback_raw");
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({
      method: "POST",
      query_string: "",
      body: JSON.stringify({
        lote: [{ id: "msg-1", parceiroId: key(1), statusConfirmacao: "CONFIRMADO" }],
      }),
      processed: 1,
      matched: 1,
    });
    expect(raw[1]).toMatchObject({ method: "GET", body: "" });
    expect(raw[1].query_string).toBe(`parceiroId=${key(2)}&statusConfirmacao=CONFIRMADO`);
  });

  it("B1: bulk is OFF unless SMS_BULK_ENABLED is exactly true", () => {
    vi.stubEnv("SMS_BULK_ENABLED", "");
    expect(smsBulkEnabled()).toBe(false);
    vi.stubEnv("SMS_BULK_ENABLED", "1");
    expect(smsBulkEnabled()).toBe(false);
    vi.stubEnv("SMS_BULK_ENABLED", "true");
    expect(smsBulkEnabled()).toBe(true);
  });

  it("B1: a 2xx whose bulk[] echoes none of the sent parceiroIds is unknown, not rejected", async () => {
    smsBehaviour = (body) =>
      Response.json({ id: "lote-x", bulk: body.bulk.map((_, i) => ({ id: `m${i}` })) });
    const items = [item(1, { linkTrackingEnabled: false }), item(2, { linkTrackingEnabled: false })];
    const r = await sendSmsBatch(items);
    expect(r.outcomes.map((o) => o.status)).toEqual(["pending_confirmation", "pending_confirmation"]);
    expect(credits.charged()).toBe(2);
    expect(logFor(key(1))[0]).toMatchObject({ status: "sent", delivery_status: "unconfirmed" });
    // never resent
    smsBehaviour = acceptAll;
    await sendSmsBatch(items);
    expect(smsCalls).toHaveLength(1);

    smsBehaviour = () =>
      Response.json({ id: "lote-y", bulk: [{ id: "z", parceiroId: "someone-else" }] });
    const other = await sendSmsBatch([item(3, { linkTrackingEnabled: false })]);
    expect(other.outcomes[0].status).toBe("pending_confirmation");
    smsBehaviour = () => Response.json({ id: "lote-z" }); // bulk[] missing
    const missing = await sendSmsBatch([item(4, { linkTrackingEnabled: false })]);
    expect(missing.outcomes[0].status).toBe("pending_confirmation");
  });

  it("B1: an explicit per-item error rejects only that item, with its reason", async () => {
    smsBehaviour = (body) =>
      Response.json({
        id: "lote-e",
        bulk: body.bulk.map((b, i) =>
          i === 0
            ? { parceiroId: b.parceiroId, status: 303, statusDetalhe: "numero invalido" }
            : { id: `m${i}`, parceiroId: b.parceiroId },
        ),
      });
    const r = await sendSmsBatch([
      item(1, { linkTrackingEnabled: false }),
      item(2, { linkTrackingEnabled: false }),
    ]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["rejected", "accepted"]);
    expect(r.outcomes[0].error).toMatch(/numero invalido/);
    expect(credits.charged()).toBe(1);
  });

  it("I2: stale submitting rows move to unconfirmed (never resent); recent rows untouched", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const row = (id: string, k: string, delivery_status: string, created_at: string) => ({
      id,
      idempotency_key: k,
      status: "sent",
      delivery_status,
      tenant_id: TENANT,
      created_at,
    });
    fake.db
      .rows("sms_send_logs")
      .push(
        row("old", key(1), "submitting", "2026-10-15T11:00:00.000Z"),
        row("new", key(2), "submitting", "2026-10-15T11:50:00.000Z"),
        row("done", key(3), "delivered", "2026-10-15T10:00:00.000Z"),
      );
    const r = await reconcileStaleSubmittingLogs({ now });
    expect(r).toEqual({ moved: 1, ids: ["old"] });
    const byId = (id: string) => logs().find((l) => l.id === id);
    expect(byId("old")?.delivery_status).toBe("unconfirmed");
    expect(byId("new")?.delivery_status).toBe("submitting");
    expect(byId("done")?.delivery_status).toBe("delivered");
    expect(smsCalls).toHaveLength(0);
  });

  it("I3: a parceiroId callback updates only the latest accepted row, not old error rows", async () => {
    fake.db.rows("sms_send_logs").push(
      {
        id: "err",
        idempotency_key: key(9),
        status: "error",
        delivery_status: "failed",
        created_at: "2026-10-15T10:00:00.000Z",
      },
      {
        id: "ok",
        idempotency_key: key(9),
        status: "sent",
        delivery_status: "sent",
        created_at: "2026-10-15T10:05:00.000Z",
      },
    );
    const handlers = (
      SmsWebhookRoute as unknown as {
        options: { server: { handlers: { GET: (i: { request: Request }) => Promise<Response> } } };
      }
    ).options.server.handlers;
    const res = await handlers.GET({
      request: new Request(
        `https://app.example/api/public/sms-webhook?token=hook-secret&parceiroId=${key(9)}&statusConfirmacao=CONFIRMADO`,
      ),
    });
    expect(await res.json()).toMatchObject({ matched: 1 });
    expect(logs().find((l) => l.id === "ok")?.delivery_status).toBe("delivered");
    expect(logs().find((l) => l.id === "err")?.delivery_status).toBe("failed");
  });

  it("I4: Short.io results are matched by originalURL only; an unmatched link is a Short.io failure", async () => {
    settings("passthrough");
    // Reversed order: positional mapping would swap the two recipients' links.
    shortioBehaviour = (links) =>
      Response.json(
        links
          .map((l, i) => ({
            idString: `id${i}`,
            shortURL: `https://go.example/k${i}`,
            originalURL: l.originalURL,
          }))
          .reverse(),
      );
    await sendSmsBatch([item(1), item(2)]);
    const dispatches = fake.db.rows("link_dispatches");
    const tracked = fake.db.rows("tracked_links");
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) {
      const t = tracked.find((x) => x.id === d.tracked_link_id)!;
      expect(String(t.original_url)).toContain(String(d.tracking_token));
      expect(d.sent_url).toBe(t.short_url);
      expect(t.status).not.toBe("failed");
    }

    // No originalURL echo: not trusted -> block mode defers the batch.
    fake.db.rows("shortio_settings").length = 0;
    settings("block");
    shortioBehaviour = (links) =>
      Response.json(links.map((_, i) => ({ idString: `x${i}`, shortURL: `https://go.example/x${i}` })));
    await expect(sendSmsBatch([item(5), item(6)])).rejects.toBeInstanceOf(SmsBatchDeferredError);
  });

  // PG1 Task 5 — billing reserves countSmsSegments(finalContent).segments
  // units from the wallet instead of a flat 1 legacy credit per send.
  describe("wallet billing: segments x price, not a flat credit", () => {
    it("a 161-unit GSM-7 message reserves 2 segments", async () => {
      const content = "A".repeat(161); // GSM-7, > 160 units -> ceil(161/153) = 2
      const r = await sendSmsBatch([item(1, { content, linkTrackingEnabled: false })]);
      expect(r.outcomes[0].status).toBe("accepted");
      expect(credits.charged()).toBe(2);
    });

    it("UCS-2 content (forced by a non-GSM-7 character) reserves 1 segment at 70 units, 2 at 71", async () => {
      // An emoji has no GSM-7 form (accents are rewritten by toGsm7Text) -> forces UCS-2.
      const ucs70 = "😀" + "a".repeat(68); // 70 UTF-16 units -> 1 segment
      const ucs71 = "😀" + "a".repeat(69); // 71 UTF-16 units -> ceil(71/67) = 2 segments
      const r1 = await sendSmsBatch([item(1, { content: ucs70, linkTrackingEnabled: false })]);
      expect(r1.outcomes[0].status).toBe("accepted");
      expect(credits.charged()).toBe(1);

      const r2 = await sendSmsBatch([item(2, { content: ucs71, linkTrackingEnabled: false })]);
      expect(r2.outcomes[0].status).toBe("accepted");
      expect(credits.charged()).toBe(3); // 1 (first item) + 2 (this one)
    });

    it("an accented name does not force UCS-2: billed as one GSM-7 segment", async () => {
      const content = "João, saque pago! Sua mare de sorte esta em alta: aproveite e redeposite agora em https://bmkt.click/n3K1mk Para sair, responda SAIR.";
      const r = await sendSmsBatch([item(1, { content, linkTrackingEnabled: false })]);
      expect(r.outcomes[0].status).toBe("accepted");
      expect(credits.charged()).toBe(1);
    });

    it("insufficient balance for a multi-segment item fails with 'Saldo insuficiente', nothing sent", async () => {
      fake.db.reset();
      credits = installCreditLedger(fake.db, { balance: () => 1 });
      fake.db.onRpc("consume_channel_budget", (args) => ({
        data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }],
        error: null,
      }));
      const content = "A".repeat(161); // 2 segments, only 1 unit of balance available
      const r = await sendSmsBatch([item(1, { content, linkTrackingEnabled: false })]);
      expect(r.outcomes[0]).toMatchObject({
        status: "failed",
        ok: false,
        error: "Saldo insuficiente",
        // Final fix I3: the campaign tick pauses on this kind.
        errorKind: "insufficient_balance",
        retryable: false,
      });
      expect(smsCalls).toHaveLength(0);
      expect(credits.charged()).toBe(0);
    });

    it("provider rejection refunds under sms-refund:<ref>; the retry reserves generation 1", async () => {
      settings("block");
      smsBehaviour = (body) =>
        Response.json({
          id: "lote-r",
          bulk: body.bulk.map((b) => ({
            parceiroId: b.parceiroId,
            status: 303,
            statusDetalhe: "numero invalido",
          })),
        });
      const first = await sendSmsBatch([item(1)]);
      expect(first.outcomes[0].status).toBe("rejected");
      expect(
        credits.ledger().some((l) => l.idempotency_key === `sms-refund:delivery:${key(1)}`),
      ).toBe(true);
      expect(credits.charged()).toBe(0);

      smsBehaviour = acceptAll;
      const second = await sendSmsBatch([item(1)]);
      expect(second.outcomes[0].status).toBe("accepted");
      expect(credits.ledger().map((l) => l.idempotency_key)).toContain(
        `sms-reserve:delivery:${key(1)}:1`,
      );
      expect(credits.charged()).toBe(1);
    });
  });
});
