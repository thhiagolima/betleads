// Task 3 — demo send guard on every outbound channel (SMS single + bulk,
// e-mail, external WhatsApp webhook, Short.io, ElevenLabs).
//
// Runs the real senders and the real fail-closed guard
// (assertTenantCanSendExternally) against an in-memory database and a mocked
// fetch. For a demo tenant nothing may reach the network and nothing may be
// recorded as sent (sms_send_logs, sms_credit_ledger, email_send_logs,
// link_dispatches). A normal tenant is the control: it reaches fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, installCreditLedger } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
// Deliverability (suppression list, unsubscribe footer) is out of scope here.
vi.mock("./email-deliverability.server", () => ({
  augmentEmailHtml: vi.fn(async (html: string) => ({ html, unsubscribeUrl: null })),
  isSuppressed: vi.fn(async () => false),
}));
// Pass-through, so a test can act at the moment a recipient is being prepared.
vi.mock("./template-vars.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./template-vars.server")>();
  return { ...actual, buildPlayerVariables: vi.fn(actual.buildPlayerVariables) };
});
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { __resetDemoTenantCacheForTests, assertTenantNotDemoForSend } from "./tenant-access.server";
import { DEMO_SEND_BLOCKED_TEXT } from "./demo-tenant";
import { callShortBrasilSmsBulk, sendSmsInternal } from "./sms.functions";
import { sendSmsBatch, type SmsBatchItem } from "./sms-bulk.server";
import { sendInfobipEmail } from "./email-send.server";
import { sendExternalTriggerEvent, type ExternalIntegration } from "./whatsapp-external.server";
import {
  createShortioLink,
  createShortioLinksBulk,
  prepareTrackedText,
  prepareTrackedTextBatch,
  syncShortioMetrics,
} from "./shortio.server";
import { callElevenLabs, DEFAULT_VOICE_SETTINGS } from "./calls.server";
import { runCampaignSend } from "./email.functions";
import { buildPlayerVariables } from "./template-vars.server";

const NORMAL = "00000000-0000-4000-8000-000000000001";
const DEMO = "00000000-0000-4000-8000-000000000002";
const SUSPENDED = "00000000-0000-4000-8000-000000000003";
const PLAYER = "33333333-3333-4333-8333-000000000001";
const GUARDED_TABLES = ["sms_send_logs", "sms_credit_ledger", "email_send_logs", "link_dispatches"];

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("bulk-sms.php")) {
      return Response.json({ id: "lote-1", bulk: [] });
    }
    if (href.includes("short.io/links/bulk")) return Response.json([]);
    if (href.includes("short.io/links")) {
      return Response.json({ id: "lnk_1", shortURL: "https://go.example/a", path: "a" });
    }
    if (href.includes("statistics.short.io")) return Response.json({ clicksStatistics: [] });
    if (href.includes("elevenlabs.io")) return new Response(new ArrayBuffer(8), { status: 200 });
    if (href.includes("/email/3/send")) return Response.json({ messages: [{ messageId: "m1" }] });
    if (href.includes("hooks.example.com")) return new Response("ok", { status: 200 });
    // Short Brasil single / shortcode API.
    return Response.json([{ external_id: "x", status: "accepted" }]);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Rows written (insert/upsert/update/rpc ledger) in the tables that mean "sent". */
function guardedWrites() {
  const writes = fake.db.calls.filter((c) => GUARDED_TABLES.includes(c.table) && c.op !== "select");
  const ledgerRows = fake.db.rows("sms_credit_ledger").length;
  return { writes, ledgerRows };
}

function expectNothingRecorded() {
  const { writes, ledgerRows } = guardedWrites();
  expect(writes).toEqual([]);
  expect(ledgerRows).toBe(0);
  expect(fake.db.rows("sms_send_logs")).toEqual([]);
  expect(fake.db.rows("email_send_logs")).toEqual([]);
  expect(fake.db.rows("link_dispatches")).toEqual([]);
}

function batchItem(tenantId: string, n = 1): SmsBatchItem {
  return {
    tenantId,
    to: `+55119${String(10000000 + n).slice(-8)}`,
    content: `Oi ${n}`,
    deliveryKey: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
    playerId: PLAYER,
    triggerName: "campanha:Teste:iGaming",
    linkTrackingEnabled: false,
  };
}

function integration(tenantId: string): ExternalIntegration {
  return {
    id: "int-1",
    tenant_id: tenantId,
    url: "https://hooks.example.com/betleads",
    active: true,
    triggers: [],
    disable_internal: true,
  };
}

const emailInput = (tenantId: string) => ({
  to: "lead@example.com",
  from: "crm@example.com",
  subject: "Oi",
  html: "<p>Oi</p>",
  tenantId,
});

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  installCreditLedger(fake.db);
  fake.db.onRpc("consume_channel_budget", (args) => ({
    data: [{ granted: args.p_n, retry_after_ms: 0, limited_by: null }],
    error: null,
  }));
  fake.db
    .rows("tenants")
    .push(
      { id: NORMAL, status: "active", is_demo: false },
      { id: DEMO, status: "active", is_demo: true },
      { id: SUSPENDED, status: "suspended", is_demo: false },
    );
  fake.db.rows("players").push({ id: PLAYER, tenant_id: DEMO });
  vi.stubEnv("SHORTCODE_SMS_TOKEN", "test-token");
  vi.stubEnv("SHORT_BRASIL_SMS_USUARIO", "user");
  vi.stubEnv("SHORT_BRASIL_SMS_CHAVE", "key");
  vi.stubEnv("SMS_BULK_ENABLED", "true");
  vi.stubEnv("SHORTIO_ENABLED", "false");
  vi.stubEnv("SHORTIO_API_KEY", "shortio-test-key");
  vi.stubEnv("ELEVENLABS_API_KEY", "eleven-test-key");
  vi.stubEnv("INFOBIP_BASE_URL", "https://infobip.example");
  vi.stubEnv("INFOBIP_API_KEY", "infobip-test-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SMS single path (sendSmsInternal)", () => {
  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no fetch, nothing recorded", async () => {
    const r = await sendSmsInternal({
      to: "+5511900000001",
      content: "Oi",
      tenantId: DEMO,
      playerId: PLAYER,
    });
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("blocks a demo tenant resolved only through the player (no tenantId)", async () => {
    const r = await sendSmsInternal({ to: "+5511900000001", content: "Oi", playerId: PLAYER });
    expect((r as { error?: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("blocks when neither tenantId nor playerId is known (fail-closed)", async () => {
    const r = await sendSmsInternal({ to: "+5511900000001", content: "Oi" });
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("blocks a demo tenant even with an invalid phone (no error log row)", async () => {
    const r = await sendSmsInternal({ to: "123", content: "Oi", tenantId: DEMO });
    expect((r as { error?: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expectNothingRecorded();
  });

  it("control: a normal tenant reaches the provider fetch", async () => {
    const r = await sendSmsInternal({ to: "+5511999999999", content: "Oi", tenantId: NORMAL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
});

describe("SMS low-level bulk transport (callShortBrasilSmsBulk)", () => {
  it("blocks a demo tenant before fetch", async () => {
    const r = await callShortBrasilSmsBulk({
      tenantId: DEMO,
      content: "Oi",
      recipients: ["+5511900000001"],
    });
    expect(r.ok).toBe(false);
    expect((r.body as { error?: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("control: a normal tenant reaches fetch", async () => {
    await callShortBrasilSmsBulk({
      tenantId: NORMAL,
      content: "Oi",
      recipients: ["+5511999999999"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SMS batch path (sendSmsBatch)", () => {
  it("bulk on (Short Brasil bulk transport): demo batch is rejected before any chunk", async () => {
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "");
    await expect(sendSmsBatch([batchItem(DEMO, 1), batchItem(DEMO, 2)])).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("bulk off (single transport): demo batch is rejected before any send", async () => {
    vi.stubEnv("SMS_BULK_ENABLED", "false");
    await expect(sendSmsBatch([batchItem(DEMO, 1)])).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("a batch mixing a demo tenant with a normal tenant is rejected as a whole", async () => {
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "");
    await expect(sendSmsBatch([batchItem(NORMAL, 1), batchItem(DEMO, 2)])).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("control: a normal tenant bulk batch reaches fetch", async () => {
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "");
    await sendSmsBatch([batchItem(NORMAL, 1)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("e-mail (sendInfobipEmail)", () => {
  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no fetch, nothing recorded", async () => {
    await expect(sendInfobipEmail(emailInput(DEMO))).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("blocks the tenant carried only by linkTracking", async () => {
    const { tenantId: _ignored, ...rest } = emailInput(DEMO);
    await expect(
      sendInfobipEmail({
        ...rest,
        linkTracking: { tenantId: DEMO, sourceType: "test", messageLogType: "email_send_logs" },
      }),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("blocks when no tenant is known (fail-closed)", async () => {
    const { tenantId: _ignored, ...rest } = emailInput(DEMO);
    await expect(sendInfobipEmail(rest)).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("control: a normal tenant reaches fetch", async () => {
    const r = await sendInfobipEmail(emailInput(NORMAL));
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("external WhatsApp webhook (sendExternalTriggerEvent)", () => {
  const lead = { id: null, telefone: "5511900000001", nome: "Lead" };

  it("blocks a demo tenant: DEMO_SEND_BLOCKED, no fetch, no event reserved", async () => {
    const r = await sendExternalTriggerEvent({
      integration: integration(DEMO),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.rows("whatsapp_external_events")).toEqual([]);
    expectNothingRecorded();
  });

  it("control: a normal tenant reaches fetch", async () => {
    const r = await sendExternalTriggerEvent({
      integration: integration(NORMAL),
      trigger: "recuperacao_vip",
      lead,
      isTest: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
  });
});

describe("Short.io", () => {
  const linkInput = (tenantId: string) => ({
    tenantId,
    originalUrl: "https://app.example/api/public/click/tok",
    domain: "go.example",
    ttlDays: null,
    sourceType: "campaign",
  });

  it("createShortioLink: demo tenant rejected with DEMO_SEND_BLOCKED, no fetch", async () => {
    await expect(createShortioLink(linkInput(DEMO))).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("createShortioLink: control, normal tenant reaches fetch", async () => {
    await createShortioLink(linkInput(NORMAL));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createShortioLinksBulk: demo tenant gets DEMO_SEND_BLOCKED per link, no fetch", async () => {
    const out = await createShortioLinksBulk({
      tenantId: DEMO,
      originalUrls: ["https://app.example/a", "https://app.example/b"],
      domain: "go.example",
      ttlDays: null,
      sourceType: "campaign",
    });
    expect(out).toHaveLength(2);
    for (const link of out) {
      expect(link.created).toBeNull();
      expect(link.error).toBe(DEMO_SEND_BLOCKED_TEXT);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("createShortioLinksBulk: control, normal tenant reaches fetch", async () => {
    await createShortioLinksBulk({
      tenantId: NORMAL,
      originalUrls: ["https://app.example/a"],
      domain: "go.example",
      ttlDays: null,
      sourceType: "campaign",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("syncShortioMetrics: no stats fetch for a demo tenant's links", async () => {
    fake.db
      .rows("tracked_links")
      .push({ id: "tl-demo", tenant_id: DEMO, shortio_link_id: "lnk_demo", status: "active" });
    await syncShortioMetrics(100, DEMO);
    await syncShortioMetrics(100);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("syncShortioMetrics: control, a normal tenant's links are fetched", async () => {
    fake.db
      .rows("tracked_links")
      .push({ id: "tl-normal", tenant_id: NORMAL, shortio_link_id: "lnk_n", status: "active" });
    await syncShortioMetrics(100, NORMAL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ElevenLabs (callElevenLabs)", () => {
  const params = (tenantId: string) => ({
    tenantId,
    text: "Olá",
    voiceId: "voice-1",
    voiceSettings: DEFAULT_VOICE_SETTINGS,
  });

  it("blocks a demo tenant with DEMO_SEND_BLOCKED, no fetch", async () => {
    await expect(callElevenLabs(params(DEMO))).rejects.toMatchObject({
      code: "DEMO_SEND_BLOCKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("control: a normal tenant reaches fetch", async () => {
    await callElevenLabs(params(NORMAL));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("assertTenantNotDemoForSend", () => {
  it("throws DEMO_SEND_BLOCKED for demo, unknown and missing tenants", async () => {
    for (const tenantId of [DEMO, "00000000-0000-4000-8000-00000000000f", null, undefined, ""]) {
      await expect(assertTenantNotDemoForSend(tenantId)).rejects.toMatchObject({
        code: "DEMO_SEND_BLOCKED",
      });
    }
  });

  it("leaves suspended and normal tenants to the channel's existing rules", async () => {
    await expect(assertTenantNotDemoForSend(SUSPENDED)).resolves.toBeUndefined();
    await expect(assertTenantNotDemoForSend(NORMAL)).resolves.toBeUndefined();
  });
});

describe("link preparation never writes link_dispatches for a demo tenant", () => {
  const trackingOn = (tenantId: string) =>
    fake.db.rows("shortio_settings").push({
      tenant_id: tenantId,
      enabled: true,
      domain: "go.example",
      fallback_mode: "passthrough",
      default_ttl_days: null,
      allowed_destination_hosts: [],
      enabled_channels: ["sms", "email"],
    });
  const context = (tenantId: string) => ({
    tenantId,
    channel: "sms" as const,
    sourceType: "campaign" as const,
    sourceId: "camp-1",
    deliveryKey: "dk-1",
  });

  beforeEach(() => {
    vi.stubEnv("CLICK_TRACKING_SECRET", "x".repeat(40));
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
  });

  it("prepareTrackedText rejects with DEMO_SEND_BLOCKED (even in passthrough mode)", async () => {
    trackingOn(DEMO);
    // An existing tracked link would otherwise be reused without Short.io.
    await expect(
      prepareTrackedText("Oferta https://casa.example/promo", context(DEMO)),
    ).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.rows("link_dispatches")).toEqual([]);
    expect(fake.db.rows("tracked_links")).toEqual([]);
  });

  it("prepareTrackedTextBatch blocks only the demo tenant's items", async () => {
    trackingOn(DEMO);
    trackingOn(NORMAL);
    const out = await prepareTrackedTextBatch([
      { content: "Oferta https://casa.example/promo", context: context(DEMO) },
      { content: "Sem link", context: context(NORMAL) },
    ]);
    expect(out[0]).toMatchObject({ ok: false, fallbackMode: "block" });
    expect((out[0] as { error: string }).error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(out[1]).toMatchObject({ ok: true, content: "Sem link" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.rows("link_dispatches")).toEqual([]);
  });
});

describe("suspended tenants keep their previous behaviour", () => {
  it("sendSmsInternal still throws the operational block message", async () => {
    await expect(
      sendSmsInternal({ to: "+5511999999999", content: "Oi", tenantId: SUSPENDED }),
    ).rejects.toThrow("Tenant bloqueado para operacoes");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("transport guard: tenant flagged demo after the top-level check", () => {
  // The flag flips while credits are being reserved (between the top guard
  // and the provider request); the cache is cleared to simulate its expiry.
  function flipToDemoOnReserve() {
    // Refunds keep the installed ledger handler; reservations flip the flag
    // once, then reserve with the same idempotency semantics.
    const ledger = installCreditLedger(fake.db);
    let flipped = false;
    fake.db.onRpc("reserve_sms_credits", (args) => {
      if (!flipped) {
        flipped = true;
        fake.db.rows("tenants").find((t) => t.id === NORMAL)!.is_demo = true;
        __resetDemoTenantCacheForTests();
      }
      const rows = ledger.ledger();
      if (
        rows.some(
          (r) => r.tenant_id === args._tenant && r.idempotency_key === args._idempotency_key,
        )
      )
        return { data: { ok: true, idempotent: true }, error: null };
      rows.push({
        tenant_id: args._tenant,
        idempotency_key: args._idempotency_key,
        reference_id: args._reference_id,
        delta_credits: -1,
      });
      return { data: { ok: true, idempotent: false }, error: null };
    });
    return ledger;
  }

  it("sendSmsInternal: no fetch, final (non-temporary) failure, credit refunded", async () => {
    const ledger = flipToDemoOnReserve();
    const r = await sendSmsInternal({ to: "+5511999999999", content: "Oi", tenantId: NORMAL });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(r.ok).toBe(false);
    expect((r as { error?: string }).error).toContain(DEMO_SEND_BLOCKED_TEXT);
    expect((r as { temporary?: boolean }).temporary).toBe(false);
    expect(ledger.charged()).toBe(0);
    expect(fake.db.rows("sms_send_logs").map((l) => l.status)).toEqual(["error"]);
  });

  it("sendSmsBatch (bulk): no fetch, chunk failed and refunded, not retryable", async () => {
    vi.stubEnv("SHORTCODE_SMS_TOKEN", "");
    const ledger = flipToDemoOnReserve();
    const { outcomes, httpCalls } = await sendSmsBatch([batchItem(NORMAL, 1)]);
    // httpCalls counts chunk attempts (incremented before postBulk), not
    // requests that reached the network: fetch stayed at 0.
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(httpCalls).toBe(1);
    expect(outcomes[0]).toMatchObject({ ok: false, status: "failed", retryable: false });
    expect(outcomes[0].error).toBe(DEMO_SEND_BLOCKED_TEXT);
    expect(ledger.charged()).toBe(0);
    expect(fake.db.rows("sms_send_logs").map((l) => l.status)).toEqual(["error"]);
  });
});

describe("tenant lookup failure is fail-closed (no provider request)", () => {
  // The `tenants` select errors once: the guard must propagate it, never pass.
  const failTenantLookup = () => fake.db.failNext("tenants", "select", "connection reset");

  it("e-mail", async () => {
    failTenantLookup();
    await expect(sendInfobipEmail(emailInput(NORMAL))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });

  it("external webhook", async () => {
    failTenantLookup();
    await expect(
      sendExternalTriggerEvent({
        integration: integration(NORMAL),
        trigger: "recuperacao_vip",
        lead: { id: null, telefone: "5511999999999", nome: "Lead" },
        isTest: true,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.rows("whatsapp_external_events")).toEqual([]);
  });

  it("Short.io single, bulk and stats", async () => {
    const link = {
      tenantId: NORMAL,
      originalUrl: "https://app.example/a",
      domain: "go.example",
      ttlDays: null,
      sourceType: "campaign",
    };
    failTenantLookup();
    await expect(createShortioLink(link)).rejects.toThrow();
    failTenantLookup();
    await expect(
      createShortioLinksBulk({ ...link, originalUrls: [link.originalUrl] }),
    ).rejects.toThrow();
    fake.db.rows("tracked_links").push({
      id: "tl-normal",
      tenant_id: NORMAL,
      shortio_link_id: "lnk_n",
      status: "active",
    });
    failTenantLookup();
    await expect(syncShortioMetrics(100, NORMAL)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("ElevenLabs", async () => {
    failTenantLookup();
    await expect(
      callElevenLabs({
        tenantId: NORMAL,
        text: "Olá",
        voiceId: "voice-1",
        voiceSettings: DEFAULT_VOICE_SETTINGS,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("SMS", async () => {
    failTenantLookup();
    await expect(
      sendSmsInternal({ to: "+5511999999999", content: "Oi", tenantId: NORMAL }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expectNothingRecorded();
  });
});

describe("e-mail campaign send (runCampaignSend)", () => {
  const CAMPAIGN = "44444444-4444-4444-8444-000000000001";
  const TEMPLATE = "55555555-5555-4555-8555-000000000001";
  const NORMAL_PLAYER = "33333333-3333-4333-8333-000000000002";

  function campaignFor(tenantId: string, playerId: string, frequencyAllowed: boolean) {
    fake.db.rows("email_campaigns").push({
      id: CAMPAIGN,
      tenant_id: tenantId,
      template_id: TEMPLATE,
      audience_filter: { audience_mode: "leads", target_player_ids: [playerId] },
      track_links: false,
    });
    fake.db.rows("email_templates").push({
      id: TEMPLATE,
      tenant_id: tenantId,
      lifecycle_status: "published",
      subject: "Oi",
      body_html: "<p>Oi</p>",
    });
    // Only a sender on a verified e-mail domain of the house can send.
    fake.db.rows("tenant_domains").push({
      id: `dom-${tenantId}`,
      tenant_id: tenantId,
      kind: "email",
      status: "verified",
      removed_at: null,
    });
    fake.db.rows("email_senders").push({
      tenant_id: tenantId,
      domain_id: `dom-${tenantId}`,
      name: "CRM",
      is_default: true,
      from_email: "crm@example.com",
      from_name: "CRM",
      reply_to: null,
    });
    fake.db.onRpc("check_contact_frequency_limit", () => ({
      data: [{ allowed: frequencyAllowed, retry_at: null, blocked_reason: "cap" }],
      error: null,
    }));
  }

  it("demo tenant: rejected before any write (no pending/error logs, no stats), no fetch", async () => {
    fake.db.rows("players").find((p) => p.id === PLAYER)!.email = "lead@example.com";
    // Frequency cap reached: without the guard this writes 'pending' rows.
    campaignFor(DEMO, PLAYER, false);
    await expect(runCampaignSend(CAMPAIGN)).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(fake.db.rows("email_send_logs")).toEqual([]);
  });

  it("tenant turning demo mid-campaign: the per-recipient catch logs nothing", async () => {
    fake.db.rows("players").push({ id: NORMAL_PLAYER, tenant_id: NORMAL, email: "n@example.com" });
    campaignFor(NORMAL, NORMAL_PLAYER, true);
    // Flip the tenant to demo while the recipient is being prepared (after the
    // campaign-level check, before the send guard).
    const real = vi.mocked(buildPlayerVariables).getMockImplementation()!;
    vi.mocked(buildPlayerVariables).mockImplementationOnce((p) => {
      fake.db.rows("tenants").find((t) => t.id === NORMAL)!.is_demo = true;
      __resetDemoTenantCacheForTests();
      return real(p);
    });
    await expect(runCampaignSend(CAMPAIGN)).rejects.toMatchObject({ code: "DEMO_SEND_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(fake.db.rows("email_send_logs")).toEqual([]);
  });
});
