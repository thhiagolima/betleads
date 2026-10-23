// Task 8 — demo tenants are a frozen, anonymized snapshot: nothing outside
// may write into one, and nothing it receives may leave it. This covers the
// INBOUND side (house webhook, Evolution webhook, click redirect,
// unsubscribe token) — the outbound/send side is Tasks 5-7.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const mocks = vi.hoisted(() => ({
  suppressEmail: vi.fn(async () => undefined),
  captureServerException: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => ({ options }),
  };
});
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
// The webhook route builds its own service client via createClient() instead
// of the app's supabaseAdmin wrapper (it runs with the secret key, outside
// RLS, so getServiceClient() is self-contained) — point it at the same fake
// db so the whole request is observable through one set of in-memory rows.
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: () => fake.db.client };
});
vi.mock("./conversion-attribution.server", () => ({
  attributeFromLastFirstPartyClick: vi.fn(async () => undefined),
}));
vi.mock("@/lib/precall-dispatcher.server", () => ({ detectPrecallResponse: vi.fn() }));
vi.mock("@/lib/whatsapp-evolution-auth.server", () => ({
  isAuthorizedEvolutionWebhook: () => true,
}));
vi.mock("@/lib/email-deliverability.server", () => ({ suppressEmail: mocks.suppressEmail }));
vi.mock("@/lib/observability/sentry.server", () => ({
  captureServerException: mocks.captureServerException,
}));

import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { processWebhookEvent } from "./webhook-process.server";
import {
  DEMO_CLICK_REDIRECT_URL,
  resetClickLimitersForTests,
  resolveAndRecordFirstPartyClick,
  signClickToken,
} from "./click-tracking.server";
import { Route as WebhookRoute } from "@/routes/api/public/webhook.$token.$evento";
import { Route as EvolutionRoute } from "@/routes/api/public/evolution-webhook";
import { confirmUnsubscribeFor } from "@/routes/u.$token";

const DEMO = "00000000-0000-4000-8000-0000000000d1";
const NORMAL = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  fake.db.reset();
  __resetDemoTenantCacheForTests();
  mocks.suppressEmail.mockClear();
  mocks.captureServerException.mockClear();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1) House webhook: /api/public/webhook/$token/$evento
// ---------------------------------------------------------------------------
describe("house webhook rejects a demo tenant (403, no writes)", () => {
  type Handler = (input: {
    request: Request;
    params: { token: string; evento: string };
  }) => Promise<Response>;
  const POST = (
    WebhookRoute as unknown as { options: { server: { handlers: { POST: Handler } } } }
  ).options.server.handlers.POST;

  const post = (token: string, evento = "login") =>
    POST({
      request: new Request(`https://betleads.io/api/public/webhook/${token}/${evento}`, {
        method: "POST",
        body: "{}",
      }),
      params: { token, evento },
    });

  it("blocks a demo tenant with 403 and never writes webhook_logs", async () => {
    fake.db.rows("tenants").push({
      id: DEMO,
      webhook_token: "tok-demo",
      webhook_secret: null,
      webhook_hmac_enforced: false,
      status: "active",
      is_demo: true,
    });
    const res = await post("tok-demo");
    expect(res.status).toBe(403);
    expect(fake.db.rows("webhook_logs")).toEqual([]);
  });

  it("control: a normal tenant still gets processed and writes webhook_logs", async () => {
    fake.db.rows("tenants").push({
      id: NORMAL,
      webhook_token: "tok-normal",
      webhook_secret: null,
      webhook_hmac_enforced: false,
      status: "active",
      is_demo: false,
    });
    const res = await post("tok-normal");
    expect(res.status).not.toBe(403);
    expect(fake.db.rows("webhook_logs").some((row: any) => row.tenant_id === NORMAL)).toBe(true);
  });

  // R11: a lookup failure is never a definitive demo/not-demo answer.
  it("a tenant lookup failure answers 503 (not 403, not 200) and writes nothing", async () => {
    fake.db.rows("tenants").push({
      id: NORMAL,
      webhook_token: "tok-err",
      webhook_secret: null,
      webhook_hmac_enforced: false,
      status: "active",
      is_demo: false,
    });
    fake.db.failNext("tenants", "select", "db unavailable");
    const res = await post("tok-err");
    expect(res.status).toBe(503);
    expect(fake.db.rows("webhook_logs")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2) Evolution webhook: ignore (200, no writes) for a demo-owned instance
// ---------------------------------------------------------------------------
describe("Evolution webhook ignores a demo tenant's instance (200, no writes)", () => {
  type Handler = (input: { request: Request }) => Promise<Response>;
  const POST = (EvolutionRoute as unknown as { options: { server: { handlers: { POST: Handler } } } })
    .options.server.handlers.POST;

  const post = (body: Record<string, unknown>) =>
    POST({
      request: new Request("https://betleads.io/api/public/evolution-webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });

  const message = (instance: string) => ({
    event: "messages.upsert",
    instance,
    data: {
      key: { remoteJid: "5511999999999@s.whatsapp.net", id: "m-1" },
      message: { conversation: "oi" },
      pushName: "Fulano",
    },
  });

  it("ignores a demo instance: 200, nothing written to whatsapp_chats/whatsapp_messages", async () => {
    fake.db.rows("whatsapp_sessions").push({
      id: "s-demo",
      instance_name: "inst-demo",
      tenant_id: DEMO,
    });
    fake.db.rows("tenants").push({ id: DEMO, status: "active", is_demo: true });

    const res = await post(message("inst-demo"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
    expect(fake.db.rows("whatsapp_chats")).toEqual([]);
    expect(fake.db.rows("whatsapp_messages")).toEqual([]);
  });

  it("control: a normal instance still processes the message", async () => {
    fake.db.rows("whatsapp_sessions").push({
      id: "s-normal",
      instance_name: "inst-normal",
      tenant_id: NORMAL,
    });
    fake.db.rows("tenants").push({ id: NORMAL, status: "active", is_demo: false });

    const res = await post(message("inst-normal"));
    expect(res.status).toBe(200);
    expect(fake.db.rows("whatsapp_chats").length).toBe(1);
    expect(fake.db.rows("whatsapp_messages").length).toBe(1);
  });

  // R11: a lookup failure is never treated as "not demo".
  it("an instance-owner lookup failure answers 503 and writes nothing", async () => {
    fake.db.rows("whatsapp_sessions").push({
      id: "s-normal",
      instance_name: "inst-normal",
      tenant_id: NORMAL,
    });
    fake.db.failNext("whatsapp_sessions", "select", "db unavailable");
    const res = await post(message("inst-normal"));
    expect(res.status).toBe(503);
    expect(fake.db.rows("whatsapp_chats")).toEqual([]);
    expect(fake.db.rows("whatsapp_messages")).toEqual([]);
  });

  it("a demo-status lookup failure (session found) answers 503 and writes nothing", async () => {
    fake.db.rows("whatsapp_sessions").push({
      id: "s-normal",
      instance_name: "inst-normal",
      tenant_id: NORMAL,
    });
    fake.db.rows("tenants").push({ id: NORMAL, status: "active", is_demo: false });
    fake.db.failNext("tenants", "select", "db unavailable");
    const res = await post(message("inst-normal"));
    expect(res.status).toBe(503);
    expect(fake.db.rows("whatsapp_chats")).toEqual([]);
    expect(fake.db.rows("whatsapp_messages")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3) Click redirect: a demo tracking_token writes nothing and goes neutral
// ---------------------------------------------------------------------------
describe("click redirect never records a demo tenant's click", () => {
  const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const secret = "click-secret-that-is-longer-than-thirty-two-chars";
  const previousSecret = process.env.CLICK_TRACKING_SECRET;

  function fakeClickDb(tenantId: string) {
    const events: Record<string, unknown>[] = [];
    const dispatch = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      tenant_id: tenantId,
      tracking_token: token,
      recipient_player_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      source_type: "journey",
      source_id: "j1",
      original_url: "https://casino.example/deposit?x=1",
      sent_at: new Date(Date.now() - 120_000).toISOString(),
    };
    const db = {
      from(table: string) {
        if (table === "link_dispatches") {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: dispatch, error: null }),
          };
          return chain;
        }
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
          insert: async (row: Record<string, unknown>) => {
            events.push(row);
            return { error: null };
          },
        };
        return chain;
      },
    };
    return { db, events };
  }

  function browserRequest() {
    return new Request(`https://app.example.test/api/public/click/${token}`, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 10) Chrome/131 Mobile Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "pt-BR,pt;q=0.9",
        "x-forwarded-for": "203.0.113.10",
      },
    });
  }

  beforeEach(() => {
    process.env.CLICK_TRACKING_SECRET = secret;
    resetClickLimitersForTests();
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CLICK_TRACKING_SECRET;
    else process.env.CLICK_TRACKING_SECRET = previousSecret;
  });

  it("a demo tenant's dispatch: 0 click_events inserts, destination is the neutral URL", async () => {
    fake.db.rows("tenants").push({ id: DEMO, status: "active", is_demo: true });
    const signature = await signClickToken(token, secret);
    const clickDb = fakeClickDb(DEMO);
    const result = await resolveAndRecordFirstPartyClick(
      { token, signature, request: browserRequest() },
      { db: clickDb.db, nowMs: () => Date.now() },
    );
    expect(result).toMatchObject({ ok: true, destination: DEMO_CLICK_REDIRECT_URL, outcome: "demo" });
    expect(clickDb.events).toEqual([]);
  });

  it("control: a normal tenant's dispatch still records the click and redirects to the real URL", async () => {
    fake.db.rows("tenants").push({ id: NORMAL, status: "active", is_demo: false });
    const signature = await signClickToken(token, secret);
    const clickDb = fakeClickDb(NORMAL);
    const result = await resolveAndRecordFirstPartyClick(
      { token, signature, request: browserRequest() },
      { db: clickDb.db, nowMs: () => Date.now() },
    );
    expect(result).toMatchObject({ ok: true, destination: "https://casino.example/deposit?x=1" });
    expect(clickDb.events.length).toBe(1);
  });

  // R11: a lookup failure is never a silent, unreported "demo" answer.
  it("a tenant lookup failure still redirects neutrally, writes nothing, and is reported", async () => {
    fake.db.failNext("tenants", "select", "db unavailable");
    const signature = await signClickToken(token, secret);
    const clickDb = fakeClickDb(NORMAL);
    const result = await resolveAndRecordFirstPartyClick(
      { token, signature, request: browserRequest() },
      { db: clickDb.db, nowMs: () => Date.now() },
    );
    expect(result).toMatchObject({ ok: true, destination: DEMO_CLICK_REDIRECT_URL, outcome: "demo" });
    expect(clickDb.events).toEqual([]);
    expect(mocks.captureServerException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4) Unsubscribe token: a demo tenant writes nothing but still answers ok
// ---------------------------------------------------------------------------
describe("unsubscribe confirmation writes nothing for a demo tenant", () => {
  const confirm = (token: string) => confirmUnsubscribeFor({ token });

  it("a demo tenant's token: ok:true, no suppressEmail call, token not marked used", async () => {
    fake.db.rows("tenants").push({ id: DEMO, status: "active", is_demo: true });
    fake.db.rows("email_unsubscribe_tokens").push({
      token: "tok-demo-unsub",
      email: "a@a.com",
      tenant_id: DEMO,
      used_at: null,
    });
    const result = await confirm("tok-demo-unsub");
    expect(result).toEqual({ ok: true });
    expect(mocks.suppressEmail).not.toHaveBeenCalled();
    expect(fake.db.rows("email_unsubscribe_tokens")[0].used_at).toBeNull();
  });

  it("control: a normal tenant's token suppresses and marks itself used", async () => {
    fake.db.rows("tenants").push({ id: NORMAL, status: "active", is_demo: false });
    fake.db.rows("email_unsubscribe_tokens").push({
      token: "tok-normal-unsub",
      email: "b@b.com",
      tenant_id: NORMAL,
      used_at: null,
    });
    const result = await confirm("tok-normal-unsub");
    expect(result).toEqual({ ok: true });
    expect(mocks.suppressEmail).toHaveBeenCalledTimes(1);
    expect(fake.db.rows("email_unsubscribe_tokens")[0].used_at).not.toBeNull();
  });

  // R11: a lookup failure is never treated as "not demo" — it must not
  // suppress/mark-used on an unverified tenant, nor silently show success.
  it("a tenant lookup failure rejects (shown as the route's error/retry state): no suppressEmail, no used_at", async () => {
    fake.db.rows("email_unsubscribe_tokens").push({
      token: "tok-err-unsub",
      email: "c@c.com",
      tenant_id: NORMAL,
      used_at: null,
    });
    fake.db.failNext("tenants", "select", "db unavailable");
    await expect(confirm("tok-err-unsub")).rejects.toThrow();
    expect(mocks.suppressEmail).not.toHaveBeenCalled();
    expect(fake.db.rows("email_unsubscribe_tokens")[0].used_at).toBeNull();
  });
});
