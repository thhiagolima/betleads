import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureServerException } from "@/lib/observability/sentry.server";
import { isDemoTenant } from "@/lib/tenant-access.server";

// Neutral destination for a demo-tenant dispatch (Global Constraints).
export const DEMO_CLICK_REDIRECT_URL = "https://demo.betleads.invalid";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const MIN_SECRET_LENGTH = 32;

type SecretEnv = Record<string, string | undefined>;

export type ClickTrackingSecretResolution =
  | { ok: true; secret: string; source: "explicit" | "CLICK_TRACKING_SECRET" | "CRON_SECRET" }
  | {
      ok: false;
      source: "explicit" | "CLICK_TRACKING_SECRET" | "CRON_SECRET" | null;
      reason: string;
    };

/**
 * Picks the HMAC secret for click tokens. Empty or whitespace-only values are
 * treated as missing (`.env.example` ships `CLICK_TRACKING_SECRET=`), so the
 * CRON_SECRET fallback still applies. A non-empty secret shorter than 32
 * characters is a misconfiguration and is reported, never silently skipped:
 * falling through would change every issued signature.
 * The returned reason never contains secret material.
 */
export function resolveClickTrackingSecret(
  explicit?: string,
  env: SecretEnv = process.env,
): ClickTrackingSecretResolution {
  const candidates = [
    ["explicit", explicit],
    ["CLICK_TRACKING_SECRET", env.CLICK_TRACKING_SECRET],
    ["CRON_SECRET", env.CRON_SECRET],
  ] as const;
  for (const [source, raw] of candidates) {
    const value = raw?.trim();
    if (!value) continue;
    if (value.length < MIN_SECRET_LENGTH) {
      return {
        ok: false,
        source,
        reason: `${source} deve possuir ao menos ${MIN_SECRET_LENGTH} caracteres (atual: ${value.length})`,
      };
    }
    return { ok: true, secret: value, source };
  }
  return {
    ok: false,
    source: null,
    reason: "CLICK_TRACKING_SECRET e CRON_SECRET ausentes ou vazios",
  };
}

let configReported = false;

/**
 * Validates the environment secret once per process. When invalid it logs a
 * clear error and reports to Sentry, but never throws: unrelated routes that
 * import this module must keep working. Tracked sends and the redirect still
 * fail closed through trackingSecret().
 */
export function validateClickTrackingConfig(env: SecretEnv = process.env): boolean {
  const resolution = resolveClickTrackingSecret(undefined, env);
  if (resolution.ok || configReported) return resolution.ok;
  configReported = true;
  const message = `[click-tracking] configuração inválida: ${resolution.reason}. Envios rastreados e o redirect /api/public/click falharão até que CLICK_TRACKING_SECRET (ou CRON_SECRET) tenha ao menos ${MIN_SECRET_LENGTH} caracteres.`;
  console.error(message);
  captureServerException(new Error(message), {
    job: "click-tracking-config",
    tags: { secret_source: resolution.source ?? "none" },
  });
  return false;
}

/** Test-only: allows the once-per-process report to fire again. */
export function resetClickTrackingConfigReportForTests() {
  configReported = false;
}

function trackingSecret(explicit?: string) {
  const resolution = resolveClickTrackingSecret(explicit);
  if (!resolution.ok) {
    if (!explicit?.trim()) validateClickTrackingConfig();
    throw new Error(
      `CLICK_TRACKING_SECRET (ou CRON_SECRET) deve possuir ao menos ${MIN_SECRET_LENGTH} caracteres: ${resolution.reason}`,
    );
  }
  return resolution.secret;
}

// Boot-time check: runs when the server bundle first loads this module (the
// click route and every tracked-send path import it). Skipped under vitest so
// tests control the environment explicitly.
if (typeof process !== "undefined" && !process.env?.VITEST) validateClickTrackingConfig();

async function hmac(value: string, explicitSecret?: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(trackingSecret(explicitSecret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

export async function signClickToken(token: string, explicitSecret?: string) {
  if (!UUID_PATTERN.test(token)) throw new Error("Token de clique inválido");
  return bytesToBase64Url((await hmac(`betleads-click-v1:${token}`, explicitSecret)).slice(0, 18));
}

export async function verifyClickTokenSignature(
  token: string,
  provided: string | null,
  explicitSecret?: string,
) {
  if (!provided || !UUID_PATTERN.test(token)) return false;
  const expected = await signClickToken(token, explicitSecret);
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return difference === 0;
}

export async function buildFirstPartyClickUrl(token: string, explicitSecret?: string) {
  const base = (
    process.env.PUBLIC_APP_URL ??
    process.env.VITE_PUBLIC_APP_URL ??
    "https://betleads.io"
  ).replace(/\/+$/, "");
  const signature = await signClickToken(token, explicitSecret);
  return `${base}/api/public/click/${encodeURIComponent(token)}?s=${encodeURIComponent(signature)}`;
}

// ---------------------------------------------------------------------------
// TRK-06 — bot, preview and abuse filtering for the first-party redirect.
//
// Every request that reaches the redirect still gets its 302. These rules only
// decide whether the event counts as a human click (`is_human`), which is the
// sole input of reported clicks and of resolve_last_attributable_click. The
// reason is stored in metadata.bot_reason; bot_classification keeps its
// existing values ('human' | 'suspected_bot' | 'unknown') so the CHECK
// constraint and the deploy order stay independent.
// ---------------------------------------------------------------------------

/**
 * Link-preview fetchers of messengers, social networks and SMS apps. They fetch
 * the URL when a message is rendered, not when someone taps it. Apple's
 * iMessage preview identifies itself with the "facebookexternalhit ...
 * Facebot Twitterbot" composite UA.
 */
const LINK_PREVIEW_PATTERN =
  /facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|slackbot|slack-imgproxy|discordbot|skypeuripreview|microsoftpreview|linkedinbot|pinterest|redditbot|embedly|iframely|vkshare|viber|snapchat|googleimageproxy|google-pagerenderer|google messages|googlemessages|com\.google\.android\.apps\.messaging|outlook|preview/i;

/**
 * Mail/URL security gateways and AV link checkers (Microsoft Defender /
 * Safe Links, Proofpoint, Mimecast, Barracuda, Cisco IronPort, Bitdefender,
 * Kaspersky, ...). Several of them also use plain browser UAs; those are
 * caught by the header and timing rules instead. Consumer browsers that ship
 * with an AV brand (Avast/AVG/Norton Secure Browser) are deliberately absent.
 */
const SECURITY_SCANNER_PATTERN =
  /safelinks|microsoft-atp|defender|proofpoint|ppops|mimecast|barracuda|ironport|cisco|bitdefender|kaspersky|trendmicro|trend micro|sophos|fortiguard|fortinet|zscaler|forcepoint|websense|symantec|checkpoint|check point|paloalto|safebrowsing|virustotal|urlscan|netcraft|phishtank|scanner/i;

/** Crawlers, headless browsers and HTTP libraries. */
const AUTOMATION_PATTERN =
  /bot\b|bot\/|crawler|spider|slurp|headless|phantomjs|selenium|puppeteer|playwright|lighthouse|curl\/|wget\/|python-|python\/|aiohttp|httpx|scrapy|go-http-client|okhttp|java\/|libwww|httpclient|apache-http|axios\/|node-fetch|undici|ruby|perl\/|php\/|postmanruntime|insomnia/i;

/** Real devices whose model name ends in "bot" (e.g. "CUBOT KINGKONG 5"). */
const DEVICE_NAME_FALSE_POSITIVES = /cubot/gi;

export const MACHINE_SPEED_MS = 3_000;
export const DUPLICATE_WINDOW_MS = 10_000;
export const IP_HOP_WINDOW_MS = 60_000;

export type ClickBotReason =
  | "missing_user_agent"
  | "head_request"
  | "prefetch"
  | "link_preview"
  | "security_scanner"
  | "automation"
  | "non_browser_headers"
  | "machine_speed"
  | "ip_hop_repeat"
  | "shortio_link_crawler";

/**
 * User-agent hashes (privacyHash, same key as click_events.user_agent_hash)
 * of fetchers that hit the redirect without a person behind them. Measured
 * on 15/10/2026: one UA made 97% of all "clicks", ~91% within 2 min of the
 * Short.io link creation, while Short.io counted 0 clicks on those short
 * links — the shortener fetching our long URL, not the player. Extend with
 * CLICK_KNOWN_CRAWLER_UA_HASHES (comma-separated) without a deploy of code.
 */
const BUILTIN_CRAWLER_UA_HASHES = ["1qFewyagIOHGqnWnCWhnJbdV"];

export function knownCrawlerUaHashes(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.CLICK_KNOWN_CRAWLER_UA_HASHES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...BUILTIN_CRAWLER_UA_HASHES, ...extra]);
}

/** Window after link creation in which a fetch is suspicious enough to keep its UA. */
const UA_SAMPLE_WINDOW_MS = 180_000;

export type ClickClassification = {
  classification: "human" | "suspected_bot" | "unknown";
  isHuman: boolean;
  reason: ClickBotReason | null;
};

export type ClickRequestSignals = {
  method: string;
  userAgent: string | null;
  accept: string | null;
  acceptLanguage: string | null;
  /** `Sec-Purpose` / `Purpose` / `X-Moz` header, when present. */
  purpose: string | null;
  /** link_dispatches.sent_at (ISO) or null when not yet marked as sent. */
  sentAt: string | null;
  nowMs: number;
};

const HUMAN: ClickClassification = { classification: "human", isHuman: true, reason: null };

function suspect(reason: ClickBotReason): ClickClassification {
  return {
    classification: reason === "missing_user_agent" ? "unknown" : "suspected_bot",
    isHuman: false,
    reason,
  };
}

/** UA-only rules: missing UA, previews, scanners, automation. */
export function classifyClickUserAgent(userAgent: string | null): ClickClassification {
  const ua = userAgent?.trim();
  // R1 — browsers always send a User-Agent; its absence is a script.
  if (!ua) return suspect("missing_user_agent");
  const normalized = ua.replace(DEVICE_NAME_FALSE_POSITIVES, "");
  // R3 — preview fetchers render the message, nobody tapped the link.
  if (LINK_PREVIEW_PATTERN.test(normalized)) return suspect("link_preview");
  // R4 — mail / SMS / AV security gateways detonating URLs.
  if (SECURITY_SCANNER_PATTERN.test(normalized)) return suspect("security_scanner");
  // R5 — crawlers, headless browsers and HTTP client libraries.
  if (AUTOMATION_PATTERN.test(normalized)) return suspect("automation");
  return HUMAN;
}

function isBrowserNavigationAccept(accept: string | null) {
  if (!accept) return false;
  return /text\/html|application\/xhtml\+xml/i.test(accept);
}

/**
 * Pure classifier for one redirect request. Rules are evaluated in order and
 * the first match wins; see TRK-06 in
 * docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md.
 */
export function classifyClickRequest(signals: ClickRequestSignals): ClickClassification {
  // R2 — HEAD never comes from a tap: link checkers probe without a body.
  if (signals.method.toUpperCase() === "HEAD") return suspect("head_request");
  const byUserAgent = classifyClickUserAgent(signals.userAgent);
  if (!byUserAgent.isHuman) return byUserAgent;
  // R2b — speculative prefetch/prerender is not a navigation.
  if (signals.purpose && /prefetch|prerender/i.test(signals.purpose)) return suspect("prefetch");
  // R6 — a browser navigation always sends Accept-Language and an Accept that
  // includes text/html. Missing both signals is a script with a spoofed UA.
  if (!signals.acceptLanguage?.trim() && !isBrowserNavigationAccept(signals.accept)) {
    return suspect("non_browser_headers");
  }
  // R7 — nobody receives, reads and taps an SMS/e-mail within 3 s of the
  // provider ack. Negative deltas are NOT flagged: sent_at is written after
  // the provider call returns (batch), so real clicks may precede it.
  if (signals.sentAt) {
    const sentMs = Date.parse(signals.sentAt);
    const delta = signals.nowMs - sentMs;
    if (Number.isFinite(sentMs) && delta >= 0 && delta < MACHINE_SPEED_MS) {
      return suspect("machine_speed");
    }
  }
  return HUMAN;
}

export type RecentClick = {
  occurredAtMs: number;
  ipHash: string | null;
  uaHash: string | null;
  isHuman: boolean;
};

export type RecentClickDecision =
  { action: "skip_duplicate" } | { action: "record"; ipHop: boolean };

/**
 * Pure dedupe/repeat decision against the recent events of the same dispatch.
 * - R8 duplicate: same ip_hash + ua_hash within 10 s of an event that is at
 *   least as "human" as this one → not inserted. A human click is never
 *   swallowed by an earlier non-human event (e.g. a machine-speed fetch).
 * - R9 IP hop: same ua_hash from a DIFFERENT ip_hash within 60 s of an
 *   earlier event → the repeat is a scanner pool re-fetching the link (the
 *   dominant pattern observed in production: two fetches, one UA, two IPs).
 *   The first event keeps its classification, so attribution is unaffected.
 */
export function evaluateRecentClicks(args: {
  recent: RecentClick[];
  ipHash: string | null;
  uaHash: string | null;
  isHuman: boolean;
  nowMs: number;
}): RecentClickDecision {
  let ipHop = false;
  for (const click of args.recent) {
    const age = args.nowMs - click.occurredAtMs;
    if (!Number.isFinite(age) || age < -DUPLICATE_WINDOW_MS || age >= IP_HOP_WINDOW_MS) continue;
    const sameUa = click.uaHash === args.uaHash;
    const sameIp = click.ipHash === args.ipHash;
    if (sameUa && sameIp && age < DUPLICATE_WINDOW_MS && (click.isHuman || !args.isHuman)) {
      return { action: "skip_duplicate" };
    }
    if (sameUa && !sameIp && args.uaHash !== null) ipHop = true;
  }
  return { action: "record", ipHop };
}

// ---------------------------------------------------------------------------
// In-process limiter (best effort, per instance). Over the limit the request
// is still redirected but not recorded, so a flood never reaches the database
// beyond the dispatch lookup (served from a short cache while throttled).
// ---------------------------------------------------------------------------

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startMs: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts the hit and returns true while the key is within its limit. */
  hit(key: string, nowMs: number): boolean {
    let entry = this.windows.get(key);
    if (!entry || nowMs - entry.startMs >= this.windowMs) {
      if (!entry && this.windows.size >= this.maxKeys) this.evict(nowMs);
      entry = { startMs: nowMs, count: 0 };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  get size() {
    return this.windows.size;
  }

  clear() {
    this.windows.clear();
  }

  private evict(nowMs: number) {
    for (const [key, entry] of this.windows) {
      if (nowMs - entry.startMs >= this.windowMs) this.windows.delete(key);
    }
    // Still full: drop the oldest quarter (Map keeps insertion order).
    if (this.windows.size >= this.maxKeys) {
      let toDrop = Math.ceil(this.maxKeys / 4);
      for (const key of this.windows.keys()) {
        if (toDrop-- <= 0) break;
        this.windows.delete(key);
      }
    }
  }
}

export const CLICK_LIMIT_PER_TOKEN_PER_MIN = 20;
export const CLICK_LIMIT_PER_IP_PER_MIN = 120;

type DispatchRow = {
  id: string;
  tenant_id: string;
  tracking_token: string;
  recipient_player_id: string | null;
  source_type: string;
  source_id: string;
  original_url: string;
  sent_at: string | null;
  created_at?: string | null;
};

const tokenLimiter = new FixedWindowLimiter(CLICK_LIMIT_PER_TOKEN_PER_MIN, 60_000);
const ipLimiter = new FixedWindowLimiter(CLICK_LIMIT_PER_IP_PER_MIN, 60_000);
const throttledDispatchCache = new Map<string, { dispatch: DispatchRow; expiresMs: number }>();
const THROTTLED_CACHE_TTL_MS = 60_000;
const THROTTLED_CACHE_MAX = 2_000;

/** Test-only: resets the in-process limiters and the throttled cache. */
export function resetClickLimitersForTests() {
  tokenLimiter.clear();
  ipLimiter.clear();
  throttledDispatchCache.clear();
}

/** Recording never delays the 302 by more than this; it finishes in background. */
export const RECORD_BUDGET_MS = 1_500;

async function privacyHash(value: string | null) {
  if (!value) return null;
  const digest = await hmac(`telemetry-v1:${value}`);
  return bytesToBase64Url(digest.slice(0, 18));
}

function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("true-client-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function refererHost(request: Request) {
  const value = request.headers.get("referer");
  if (!value) return null;
  try {
    return new URL(value).hostname.slice(0, 255) || null;
  } catch {
    return null;
  }
}

function shortHeader(request: Request, name: string, max = 32) {
  return request.headers.get(name)?.slice(0, max) ?? null;
}

export type ClickRecordOutcome =
  | "recorded"
  | "duplicate"
  | "rate_limited"
  | "error"
  | "pending"
  | "demo";

type RecordResult = { outcome: ClickRecordOutcome; trackingError: string | null };

type ClickDeps = {
  db?: any;
  nowMs?: () => number;
  recordBudgetMs?: number;
  isDemoTenant?: (tenantId: string) => Promise<boolean>;
};

async function recordClick(args: {
  db: any;
  dispatch: DispatchRow;
  request: Request;
  nowMs: number;
}): Promise<RecordResult> {
  const { db, dispatch, request, nowMs } = args;
  const headers = request.headers;
  const userAgent = headers.get("user-agent");
  const accept = headers.get("accept");
  let verdict = classifyClickRequest({
    method: request.method,
    userAgent,
    accept,
    acceptLanguage: headers.get("accept-language"),
    purpose: headers.get("sec-purpose") ?? headers.get("purpose") ?? headers.get("x-moz"),
    sentAt: dispatch.sent_at,
    nowMs,
  });
  const [ipHash, uaHash] = await Promise.all([
    privacyHash(requestIp(request)),
    privacyHash(userAgent),
  ]);
  if (uaHash && knownCrawlerUaHashes().has(uaHash)) verdict = suspect("shortio_link_crawler");
  const createdAtMs = dispatch.created_at ? Date.parse(dispatch.created_at) : Number.NaN;
  // Keep the raw UA only for suspicious fetches (bot verdict or right after the
  // link was created) so new crawlers can be identified; never for players.
  const keepUaSample =
    !verdict.isHuman || (Number.isFinite(createdAtMs) && nowMs - createdAtMs < UA_SAMPLE_WINDOW_MS);

  // Cheap: served by click_events_dispatch_time_idx (link_dispatch_id, occurred_at desc).
  const { data: recentRows, error: recentError } = await db
    .from("click_events")
    .select("occurred_at,ip_hash,user_agent_hash,is_human")
    .eq("link_dispatch_id", dispatch.id)
    .gte("occurred_at", new Date(nowMs - IP_HOP_WINDOW_MS).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(20);
  // A failed lookup must not drop the click: record it and let the unique
  // bucket key below absorb concurrent duplicates.
  const recent: RecentClick[] = recentError
    ? []
    : ((recentRows ?? []) as any[]).map((row) => ({
        occurredAtMs: Date.parse(String(row.occurred_at)),
        ipHash: row.ip_hash ?? null,
        uaHash: row.user_agent_hash ?? null,
        isHuman: Boolean(row.is_human),
      }));
  const decision = evaluateRecentClicks({
    recent,
    ipHash,
    uaHash,
    isHuman: verdict.isHuman,
    nowMs,
  });
  if (decision.action === "skip_duplicate") return { outcome: "duplicate", trackingError: null };
  if (decision.ipHop && verdict.isHuman) verdict = suspect("ip_hop_repeat");

  // Race-free dedupe for concurrent requests: one row per 10 s bucket per
  // (dispatch, ip, ua, humanity) through the existing unique (tenant_id, request_id).
  const bucket = Math.floor(nowMs / DUPLICATE_WINDOW_MS);
  const bucketDigest = await hmac(
    `click-dedupe-v1:${dispatch.id}|${ipHash}|${uaHash}|${verdict.isHuman ? 1 : 0}|${bucket}`,
  );
  const { error: insertError } = await db.from("click_events").insert({
    tenant_id: dispatch.tenant_id,
    link_dispatch_id: dispatch.id,
    tracking_token: dispatch.tracking_token,
    request_id: `dd1:${bytesToBase64Url(bucketDigest.slice(0, 18))}`,
    ip_hash: ipHash,
    user_agent_hash: uaHash,
    referer_host: refererHost(request),
    bot_classification: verdict.classification,
    is_human: verdict.isHuman,
    metadata: {
      country: headers.get("cf-ipcountry")?.slice(0, 8) ?? null,
      source_type: dispatch.source_type,
      source_id: dispatch.source_id,
      player_bound: Boolean(dispatch.recipient_player_id),
      classifier: "trk06-v1",
      bot_reason: verdict.reason,
      // Non-PII request shape, kept to re-measure the rules in production.
      accept_kind: !accept ? "none" : isBrowserNavigationAccept(accept) ? "html" : "other",
      accept_language: Boolean(headers.get("accept-language")?.trim()),
      sec_fetch_mode: shortHeader(request, "sec-fetch-mode"),
      sec_fetch_site: shortHeader(request, "sec-fetch-site"),
      request_ref: (headers.get("cf-ray") ?? headers.get("x-request-id"))?.slice(0, 64) ?? null,
      ua_sample: keepUaSample ? (userAgent?.slice(0, 200) ?? null) : null,
    },
  });
  if (insertError?.code === "23505") return { outcome: "duplicate", trackingError: null };
  if (insertError) {
    return { outcome: "error", trackingError: `Falha ao registrar clique: ${insertError.message}` };
  }
  return { outcome: "recorded", trackingError: null };
}

function rememberThrottledDispatch(token: string, dispatch: DispatchRow, nowMs: number) {
  if (throttledDispatchCache.size >= THROTTLED_CACHE_MAX) throttledDispatchCache.clear();
  throttledDispatchCache.set(token, { dispatch, expiresMs: nowMs + THROTTLED_CACHE_TTL_MS });
}

export async function resolveAndRecordFirstPartyClick(
  args: { token: string; signature: string | null; request: Request },
  deps: ClickDeps = {},
) {
  if (!(await verifyClickTokenSignature(args.token, args.signature))) {
    return { ok: false as const, status: 404, reason: "invalid_token" };
  }
  const db = deps.db ?? (supabaseAdmin as any);
  const nowMs = (deps.nowMs ?? Date.now)();

  // The limiter runs after the signature check so forged tokens cannot fill it.
  const ip = requestIp(args.request);
  const tokenAllowed = tokenLimiter.hit(args.token, nowMs);
  const ipAllowed = ip ? ipLimiter.hit(ip, nowMs) : true;
  const throttled = !tokenAllowed || !ipAllowed;

  let dispatch: DispatchRow | null = null;
  const cached = throttled ? throttledDispatchCache.get(args.token) : undefined;
  if (cached && cached.expiresMs > nowMs) {
    dispatch = cached.dispatch;
  } else {
    const { data, error: dispatchError } = await db
      .from("link_dispatches")
      .select(
        "id,tenant_id,tracking_token,recipient_player_id,source_type,source_id,original_url,sent_at,created_at",
      )
      .eq("tracking_token", args.token)
      .maybeSingle();
    if (dispatchError) throw new Error(`Falha ao resolver dispatch: ${dispatchError.message}`);
    dispatch = (data as DispatchRow | null) ?? null;
    if (dispatch && throttled) rememberThrottledDispatch(args.token, dispatch, nowMs);
  }
  if (!dispatch) return { ok: false as const, status: 404, reason: "dispatch_not_found" };

  // Demo tenant: the dispatch is part of a frozen snapshot. No click_events
  // insert, no dispatch counters — redirect to a neutral page instead of the
  // (possibly real) casino URL. A failed tenant lookup is demo-unsafe
  // (isDemoTenant returns true), so it also redirects here without writing.
  const checkDemo = deps.isDemoTenant ?? isDemoTenant;
  if (await checkDemo(dispatch.tenant_id)) {
    return {
      ok: true as const,
      destination: DEMO_CLICK_REDIRECT_URL,
      duplicate: false,
      outcome: "demo" as ClickRecordOutcome,
      trackingError: null,
    };
  }

  let destination: URL;
  try {
    destination = new URL(String(dispatch.original_url));
    if (destination.protocol !== "https:" && destination.protocol !== "http:") throw new Error();
  } catch {
    return { ok: false as const, status: 410, reason: "invalid_destination" };
  }

  if (throttled) {
    return {
      ok: true as const,
      destination: destination.toString(),
      duplicate: false,
      outcome: "rate_limited" as ClickRecordOutcome,
      trackingError: null,
    };
  }

  // Delivery must never be held hostage by telemetry: any recording failure is
  // surfaced to observability while the player still reaches the casino, and a
  // slow database cannot delay the 302 beyond the record budget (the insert
  // keeps running in background on the long-lived Node server).
  const recording: Promise<RecordResult> = recordClick({
    db,
    dispatch,
    request: args.request,
    nowMs,
  }).catch((error: unknown) => ({
    outcome: "error" as const,
    trackingError: `Falha ao registrar clique: ${error instanceof Error ? error.message : String(error)}`,
  }));
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<RecordResult>((resolve) => {
    budgetTimer = setTimeout(
      () => resolve({ outcome: "pending", trackingError: null }),
      deps.recordBudgetMs ?? RECORD_BUDGET_MS,
    );
  });
  const result = await Promise.race([recording, budget]);
  clearTimeout(budgetTimer);
  if (result.outcome === "pending") {
    void recording.then((late) => {
      if (late.trackingError) {
        console.error("[click redirect] late click event was not persisted", {
          error: late.trackingError,
        });
      }
    });
  }

  return {
    ok: true as const,
    destination: destination.toString(),
    duplicate: result.outcome === "duplicate",
    outcome: result.outcome,
    trackingError: result.trackingError,
  };
}
