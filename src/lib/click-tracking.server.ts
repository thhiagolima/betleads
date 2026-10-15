import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureServerException } from "@/lib/observability/sentry.server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_PATTERN =
  /bot|crawler|spider|preview|facebookexternalhit|facebot|whatsapp|telegrambot|slackbot|discordbot|googleimageproxy|outlook|skypeuripreview|headless/i;

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

export function classifyClickUserAgent(userAgent: string | null) {
  if (!userAgent) return { classification: "unknown" as const, isHuman: true };
  if (BOT_PATTERN.test(userAgent)) {
    return { classification: "suspected_bot" as const, isHuman: false };
  }
  return { classification: "human" as const, isHuman: true };
}

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

export async function resolveAndRecordFirstPartyClick(args: {
  token: string;
  signature: string | null;
  request: Request;
}) {
  if (!(await verifyClickTokenSignature(args.token, args.signature))) {
    return { ok: false as const, status: 404, reason: "invalid_token" };
  }

  const db = supabaseAdmin as any;
  const { data: dispatch, error: dispatchError } = await db
    .from("link_dispatches")
    .select("id,tenant_id,tracking_token,recipient_player_id,source_type,source_id,original_url")
    .eq("tracking_token", args.token)
    .maybeSingle();
  if (dispatchError) throw new Error(`Falha ao resolver dispatch: ${dispatchError.message}`);
  if (!dispatch) return { ok: false as const, status: 404, reason: "dispatch_not_found" };

  let destination: URL;
  try {
    destination = new URL(String(dispatch.original_url));
    if (destination.protocol !== "https:" && destination.protocol !== "http:") throw new Error();
  } catch {
    return { ok: false as const, status: 410, reason: "invalid_destination" };
  }

  const userAgent = args.request.headers.get("user-agent");
  const bot = classifyClickUserAgent(userAgent);
  const requestId =
    args.request.headers.get("cf-ray") ?? args.request.headers.get("x-request-id") ?? null;
  const { error: insertError } = await db.from("click_events").insert({
    tenant_id: dispatch.tenant_id,
    link_dispatch_id: dispatch.id,
    tracking_token: dispatch.tracking_token,
    request_id: requestId?.slice(0, 255) ?? null,
    ip_hash: await privacyHash(requestIp(args.request)),
    user_agent_hash: await privacyHash(userAgent),
    referer_host: refererHost(args.request),
    bot_classification: bot.classification,
    is_human: bot.isHuman,
    metadata: {
      country: args.request.headers.get("cf-ipcountry")?.slice(0, 8) ?? null,
      source_type: dispatch.source_type,
      source_id: dispatch.source_id,
      player_bound: Boolean(dispatch.recipient_player_id),
    },
  });
  // Delivery must never be held hostage by telemetry. The final destination
  // was validated above; a database outage is surfaced to observability while
  // the player still reaches the casino. Phase 2 will durably enqueue this
  // event for replay when the insert is unavailable.
  const trackingError =
    insertError && insertError.code !== "23505"
      ? `Falha ao registrar clique: ${insertError.message}`
      : null;

  return {
    ok: true as const,
    destination: destination.toString(),
    duplicate: insertError?.code === "23505",
    trackingError,
  };
}
