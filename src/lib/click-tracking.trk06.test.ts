import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLICK_LIMIT_PER_TOKEN_PER_MIN,
  FixedWindowLimiter,
  classifyClickRequest,
  classifyClickUserAgent,
  evaluateRecentClicks,
  resetClickLimitersForTests,
  resolveAndRecordFirstPartyClick,
  signClickToken,
  type ClickRequestSignals,
} from "./click-tracking.server";

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const INSTAGRAM_IAB =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0 (iPhone15,2; iOS 18_6; pt_BR)";
const CUBOT =
  "Mozilla/5.0 (Linux; Android 11; CUBOT KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

function signals(overrides: Partial<ClickRequestSignals> = {}): ClickRequestSignals {
  return {
    method: "GET",
    userAgent: ANDROID_CHROME,
    accept: BROWSER_ACCEPT,
    acceptLanguage: "pt-BR,pt;q=0.9",
    purpose: null,
    sentAt: new Date(NOW - 90_000).toISOString(),
    nowMs: NOW,
    ...overrides,
  };
}

describe("TRK-06 classification", () => {
  it("keeps real mobile and desktop browsers human", () => {
    for (const ua of [ANDROID_CHROME, IPHONE_SAFARI, INSTAGRAM_IAB, CUBOT]) {
      expect(classifyClickRequest(signals({ userAgent: ua }))).toEqual({
        classification: "human",
        isHuman: true,
        reason: null,
      });
    }
  });

  it("keeps a browser human when only one of the header signals is missing", () => {
    expect(classifyClickRequest(signals({ acceptLanguage: null })).isHuman).toBe(true);
    expect(classifyClickRequest(signals({ accept: "*/*" })).isHuman).toBe(true);
  });

  it("R1 flags a missing or blank User-Agent", () => {
    expect(classifyClickRequest(signals({ userAgent: null }))).toMatchObject({
      isHuman: false,
      classification: "unknown",
      reason: "missing_user_agent",
    });
    expect(classifyClickRequest(signals({ userAgent: "  " })).reason).toBe("missing_user_agent");
  });

  it("R2 flags HEAD requests and speculative prefetches", () => {
    expect(classifyClickRequest(signals({ method: "HEAD" })).reason).toBe("head_request");
    expect(classifyClickRequest(signals({ purpose: "prefetch;prerender" })).reason).toBe(
      "prefetch",
    );
  });

  it.each([
    ["WhatsApp/2.24.1 A", "link_preview"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
      "link_preview",
    ],
    ["TelegramBot (like TwitterBot)", "link_preview"],
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "link_preview"],
    ["Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5", "link_preview"],
    ["Mozilla/5.0 (Linux; Android 14) Google Messages link preview", "link_preview"],
    ["Mozilla/5.0 Microsoft-ATP SafeLinks", "security_scanner"],
    ["Proofpoint URL Defense", "security_scanner"],
    ["Mimecast-Url-Protect/1.0", "security_scanner"],
    ["Barracuda Sentinel (EE)", "security_scanner"],
    ["Cisco IronPort WSA", "security_scanner"],
    ["Mozilla/5.0 Bitdefender TrafficLight", "security_scanner"],
    ["Kaspersky URL Advisor", "security_scanner"],
    ["Googlebot/2.1 (+http://www.google.com/bot.html)", "automation"],
    ["Mozilla/5.0 HeadlessChrome/131.0", "automation"],
    ["python-requests/2.31.0", "automation"],
    ["curl/8.5.0", "automation"],
    ["Go-http-client/2.0", "automation"],
    ["okhttp/4.12.0", "automation"],
  ])("R3-R5 flags %s as %s", (ua, reason) => {
    expect(classifyClickUserAgent(ua)).toMatchObject({ isHuman: false, reason });
    expect(classifyClickRequest(signals({ userAgent: ua })).reason).toBe(reason);
  });

  it("R6 flags a browser UA without Accept-Language and without an HTML Accept", () => {
    expect(classifyClickRequest(signals({ acceptLanguage: null, accept: "*/*" })).reason).toBe(
      "non_browser_headers",
    );
    expect(classifyClickRequest(signals({ acceptLanguage: "", accept: null })).reason).toBe(
      "non_browser_headers",
    );
  });

  it("R7 flags clicks under 3 s after sent_at but never negative deltas", () => {
    const at = (deltaMs: number) => new Date(NOW - deltaMs).toISOString();
    expect(classifyClickRequest(signals({ sentAt: at(0) })).reason).toBe("machine_speed");
    expect(classifyClickRequest(signals({ sentAt: at(2_999) })).reason).toBe("machine_speed");
    expect(classifyClickRequest(signals({ sentAt: at(3_000) })).isHuman).toBe(true);
    // sent_at is written after the provider ack, so it can trail a real click.
    expect(classifyClickRequest(signals({ sentAt: at(-20_000) })).isHuman).toBe(true);
    expect(classifyClickRequest(signals({ sentAt: null })).isHuman).toBe(true);
    expect(classifyClickRequest(signals({ sentAt: "not-a-date" })).isHuman).toBe(true);
  });
});

describe("TRK-06 dedupe and repeats", () => {
  const base = { ipHash: "ip-a", uaHash: "ua-a", isHuman: true, nowMs: NOW };

  it("R8 skips the same ip+ua within 10 s", () => {
    const recent = [{ occurredAtMs: NOW - 4_000, ipHash: "ip-a", uaHash: "ua-a", isHuman: true }];
    expect(evaluateRecentClicks({ ...base, recent })).toEqual({ action: "skip_duplicate" });
  });

  it("R8 records again after 10 s", () => {
    const recent = [{ occurredAtMs: NOW - 10_000, ipHash: "ip-a", uaHash: "ua-a", isHuman: true }];
    expect(evaluateRecentClicks({ ...base, recent })).toEqual({ action: "record", ipHop: false });
  });

  it("R8 never swallows a human click behind an earlier non-human event", () => {
    const recent = [{ occurredAtMs: NOW - 2_000, ipHash: "ip-a", uaHash: "ua-a", isHuman: false }];
    expect(evaluateRecentClicks({ ...base, recent })).toEqual({ action: "record", ipHop: false });
    expect(evaluateRecentClicks({ ...base, isHuman: false, recent })).toEqual({
      action: "skip_duplicate",
    });
  });

  it("R9 flags the same UA from another IP within 60 s", () => {
    const recent = [{ occurredAtMs: NOW - 30_000, ipHash: "ip-b", uaHash: "ua-a", isHuman: true }];
    expect(evaluateRecentClicks({ ...base, recent })).toEqual({ action: "record", ipHop: true });
    const old = [{ occurredAtMs: NOW - 61_000, ipHash: "ip-b", uaHash: "ua-a", isHuman: true }];
    expect(evaluateRecentClicks({ ...base, recent: old })).toEqual({
      action: "record",
      ipHop: false,
    });
    const otherUa = [{ occurredAtMs: NOW - 5_000, ipHash: "ip-b", uaHash: "ua-b", isHuman: true }];
    expect(evaluateRecentClicks({ ...base, recent: otherUa })).toEqual({
      action: "record",
      ipHop: false,
    });
  });
});

describe("TRK-06 in-process limiter", () => {
  it("allows up to the limit per window and resets on the next window", () => {
    const limiter = new FixedWindowLimiter(3, 60_000);
    expect([1, 2, 3, 4].map(() => limiter.hit("t", NOW))).toEqual([true, true, true, false]);
    expect(limiter.hit("other", NOW)).toBe(true);
    expect(limiter.hit("t", NOW + 60_000)).toBe(true);
  });

  it("stays bounded in memory", () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 100);
    for (let index = 0; index < 1_000; index++) limiter.hit(`k${index}`, NOW);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// resolveAndRecordFirstPartyClick with an in-memory database
// ---------------------------------------------------------------------------

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "test-secret-that-is-longer-than-thirty-two-characters";

type Row = Record<string, any>;

function fakeDb(options: { sentAt?: string | null; insertDelayMs?: number } = {}) {
  const events: Row[] = [];
  const counters = { dispatchLookups: 0, recentQueries: 0, inserts: 0 };
  const dispatch = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    tenant_id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    tracking_token: token,
    recipient_player_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
    source_type: "journey",
    source_id: "j1",
    original_url: "https://casino.example/deposit?x=1",
    sent_at: options.sentAt === undefined ? new Date(NOW - 120_000).toISOString() : options.sentAt,
  };
  const db = {
    from(table: string) {
      if (table === "link_dispatches") {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            counters.dispatchLookups++;
            return { data: dispatch, error: null };
          },
        };
        return chain;
      }
      const filters: { since?: number } = {};
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gte: (_column: string, value: string) => {
          filters.since = Date.parse(value);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          counters.recentQueries++;
          const rows = events
            .filter((event) => Date.parse(event.occurred_at) >= (filters.since ?? 0))
            .map((event) => ({
              occurred_at: event.occurred_at,
              ip_hash: event.ip_hash,
              user_agent_hash: event.user_agent_hash,
              is_human: event.is_human,
            }));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
        insert: async (row: Row) => {
          counters.inserts++;
          if (options.insertDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.insertDelayMs));
          }
          if (events.some((event) => event.request_id === row.request_id)) {
            return { error: { code: "23505", message: "duplicate key" } };
          }
          events.push({ ...row, occurred_at: new Date(clock.now).toISOString() });
          return { error: null };
        },
      };
      return chain;
    },
  };
  return { db, events, counters };
}

const clock = { now: NOW };

function browserRequest(headers: Record<string, string> = {}, method = "GET") {
  return new Request(`https://app.example.test/api/public/click/${token}`, {
    method,
    headers: {
      "user-agent": ANDROID_CHROME,
      accept: BROWSER_ACCEPT,
      "accept-language": "pt-BR,pt;q=0.9",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
  });
}

describe("TRK-06 resolveAndRecordFirstPartyClick", () => {
  const previousSecret = process.env.CLICK_TRACKING_SECRET;
  let signature: string;

  beforeEach(async () => {
    process.env.CLICK_TRACKING_SECRET = secret;
    signature = await signClickToken(token, secret);
    resetClickLimitersForTests();
    clock.now = NOW;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CLICK_TRACKING_SECRET;
    else process.env.CLICK_TRACKING_SECRET = previousSecret;
    vi.restoreAllMocks();
  });

  const run = (fake: ReturnType<typeof fakeDb>, request: Request, extra = {}) =>
    resolveAndRecordFirstPartyClick(
      { token, signature, request },
      { db: fake.db, nowMs: () => clock.now, isDemoTenant: async () => false, ...extra },
    );

  it("records a human click with its reason metadata and a bucket dedupe key", async () => {
    const fake = fakeDb();
    const result = await run(fake, browserRequest());
    expect(result).toMatchObject({
      ok: true,
      destination: "https://casino.example/deposit?x=1",
      outcome: "recorded",
    });
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({
      is_human: true,
      bot_classification: "human",
      metadata: { bot_reason: null, accept_kind: "html", accept_language: true },
    });
    expect(String(fake.events[0].request_id)).toMatch(/^dd1:/);
    // No raw IP or UA is persisted.
    expect(JSON.stringify(fake.events[0])).not.toContain("203.0.113.10");
    expect(JSON.stringify(fake.events[0])).not.toContain("Chrome/141");
  });

  it("records previews as non-human and still redirects", async () => {
    const fake = fakeDb();
    const result = await run(fake, browserRequest({ "user-agent": "WhatsApp/2.24.1 A" }));
    expect(result).toMatchObject({ ok: true, outcome: "recorded" });
    expect(fake.events[0]).toMatchObject({
      is_human: false,
      bot_classification: "suspected_bot",
      metadata: { bot_reason: "link_preview" },
    });
  });

  it("flags a machine-speed click right after sent_at", async () => {
    const fake = fakeDb({ sentAt: new Date(NOW - 1_000).toISOString() });
    await run(fake, browserRequest());
    expect(fake.events[0]).toMatchObject({
      is_human: false,
      metadata: { bot_reason: "machine_speed" },
    });
  });

  it("dedupes repeated clicks of the same device within 10 s", async () => {
    const fake = fakeDb();
    await run(fake, browserRequest());
    clock.now = NOW + 4_000;
    const second = await run(fake, browserRequest());
    expect(second).toMatchObject({ ok: true, duplicate: true, outcome: "duplicate" });
    clock.now = NOW + 15_000;
    const third = await run(fake, browserRequest());
    expect(third).toMatchObject({ outcome: "recorded" });
    expect(fake.events).toHaveLength(2);
    expect(fake.events.every((event) => event.is_human)).toBe(true);
  });

  it("absorbs concurrent duplicates through the unique bucket key", async () => {
    const fake = fakeDb();
    const [first, second] = await Promise.all([
      run(fake, browserRequest()),
      run(fake, browserRequest()),
    ]);
    expect([first, second].filter((result: any) => result.outcome === "recorded")).toHaveLength(1);
    expect(fake.events).toHaveLength(1);
  });

  it("marks the same UA from another IP within 60 s as a scanner repeat", async () => {
    const fake = fakeDb();
    await run(fake, browserRequest());
    clock.now = NOW + 20_000;
    await run(fake, browserRequest({ "x-forwarded-for": "198.51.100.7" }));
    expect(fake.events.map((event) => event.is_human)).toEqual([true, false]);
    expect(fake.events[1].metadata.bot_reason).toBe("ip_hop_repeat");
  });

  it("stops recording above the per-token limit but keeps redirecting", async () => {
    const fake = fakeDb();
    const results = [];
    for (let index = 0; index < CLICK_LIMIT_PER_TOKEN_PER_MIN + 5; index++) {
      clock.now = NOW + index; // same minute
      results.push(
        await run(fake, browserRequest({ "x-forwarded-for": `203.0.113.${index + 1}` })),
      );
    }
    expect(results.every((result: any) => result.ok && result.destination)).toBe(true);
    const limited = results.filter((result: any) => result.outcome === "rate_limited");
    expect(limited).toHaveLength(5);
    expect(fake.counters.inserts).toBe(CLICK_LIMIT_PER_TOKEN_PER_MIN);
    // While throttled the dispatch comes from the short cache.
    expect(fake.counters.dispatchLookups).toBe(CLICK_LIMIT_PER_TOKEN_PER_MIN + 1);
  });

  it("does not hold the redirect when recording is slow", async () => {
    const fake = fakeDb({ insertDelayMs: 1_500 });
    const started = Date.now();
    const result = await run(fake, browserRequest(), { recordBudgetMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: true, outcome: "pending", trackingError: null });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(fake.events).toHaveLength(1);
  });

  it("redirects even when the recent-click lookup and the insert fail", async () => {
    const fake = fakeDb();
    const failing = {
      from(table: string) {
        if (table === "link_dispatches") return fake.db.from(table);
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "timeout" } }).then(resolve),
          insert: async () => {
            throw new Error("connection reset");
          },
        };
        return chain;
      },
    };
    const result = await resolveAndRecordFirstPartyClick(
      { token, signature, request: browserRequest() },
      { db: failing, nowMs: () => NOW, isDemoTenant: async () => false },
    );
    expect(result).toMatchObject({
      ok: true,
      destination: "https://casino.example/deposit?x=1",
      outcome: "error",
    });
    expect((result as any).trackingError).toContain("connection reset");
  });

  it("rejects forged tokens before touching the limiter or the database", async () => {
    const fake = fakeDb();
    const result = await resolveAndRecordFirstPartyClick(
      { token, signature: "forged", request: browserRequest() },
      { db: fake.db, nowMs: () => NOW },
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(fake.counters.dispatchLookups).toBe(0);
  });
});

describe("known crawler user agents", () => {
  it("includes the Short.io link crawler measured on 15/10/2026", async () => {
    const { knownCrawlerUaHashes } = await import("./click-tracking.server");
    expect(knownCrawlerUaHashes({} as NodeJS.ProcessEnv).has("1qFewyagIOHGqnWnCWhnJbdV")).toBe(true);
  });

  it("accepts extra hashes from CLICK_KNOWN_CRAWLER_UA_HASHES", async () => {
    const { knownCrawlerUaHashes } = await import("./click-tracking.server");
    const set = knownCrawlerUaHashes({ CLICK_KNOWN_CRAWLER_UA_HASHES: " abc , def ,," } as NodeJS.ProcessEnv);
    expect(set.has("abc")).toBe(true);
    expect(set.has("def")).toBe(true);
    expect(set.has("")).toBe(false);
  });
});
