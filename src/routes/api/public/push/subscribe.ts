// Web push (OneSignal) — Task 8: public subscription endpoint, called by the
// loader script on init and on every PushSubscription "change".
//
// Security:
// - `recordSubscription` is the only thing allowed to decide whether the
//   caller's origin is legitimate; this handler never trusts it beyond what
//   that function validates.
// - `Access-Control-Allow-Origin` reflects the request's Origin header only
//   when the subscription was accepted (status 200) — a rejected request
//   gets no CORS header pointing back at the caller's own origin.
// - A bounded in-memory token-bucket per IP (`x-forwarded-for`'s first
//   value) caps abuse at 60 req/min; stale buckets are swept so the map
//   cannot grow without limit under a sustained flood of distinct IPs.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordSubscription } from "@/lib/webpush/subscriptions.server";

const RATE_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
// Hard cap on tracked IPs: once exceeded, a sweep drops every bucket whose
// window has already lapsed before admitting the new one. Bounds memory
// even if a flood of distinct IPs never comes back to let their own bucket
// expire naturally.
const MAX_TRACKED_IPS = 5_000;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

function sweepStale(now: number): void {
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(ip);
  }
}

/** Returns true when `ip` has exceeded the per-minute budget. */
function isRateLimited(ip: string, now: number): boolean {
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    if (buckets.size >= MAX_TRACKED_IPS) sweepStale(now);
    buckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MINUTE;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]!.trim() || "unknown";
}

/** CORS headers for the response. `allowOrigin` is non-null only once the
 * caller's origin has actually been validated against a registered app. */
function corsHeaders(allowOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

type SubscribeBody = { subscriptionId?: unknown; optedIn?: unknown; playerId?: unknown };

async function handleSubscribe(request: Request): Promise<Response> {
  const ip = clientIp(request);
  if (isRateLimited(ip, Date.now())) {
    return Response.json({ error: "too_many_requests" }, { status: 429, headers: corsHeaders(null) });
  }

  const origin = request.headers.get("origin");
  const token = new URL(request.url).searchParams.get("t") ?? "";

  let body: SubscribeBody = {};
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    // Malformed/empty body: fall through with defaults so a bare ping can
    // still record script_seen_at.
  }

  const result = await recordSubscription(supabaseAdmin, {
    token,
    origin,
    subscriptionId: typeof body.subscriptionId === "string" ? body.subscriptionId : null,
    optedIn: body.optedIn === true,
    playerId: body.playerId,
    userAgent: request.headers.get("user-agent"),
    now: new Date(),
  });

  if (result.status !== 200) {
    return Response.json({ error: "rejected" }, { status: result.status, headers: corsHeaders(null) });
  }
  return Response.json(
    { clickKey: result.clickKey },
    { status: 200, headers: corsHeaders(origin) },
  );
}

export const Route = createFileRoute("/api/public/push/subscribe")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) }),
      POST: async ({ request }) => handleSubscribe(request),
    },
  },
});
