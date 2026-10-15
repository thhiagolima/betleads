// Public health check for Better Stack uptime monitors (OBS-04).
// GET only, no auth, no side effects. Reports process liveness plus a cheap,
// time-boxed database probe. Never returns secrets or configuration values.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DB_TIMEOUT_MS = 2_000;
// The endpoint is public: cache the DB probe briefly so a burst of requests
// cannot turn into a burst of database queries.
const DB_CACHE_MS = 5_000;

type DbState = "ok" | "degraded";
let cached: { at: number; state: DbState } | null = null;
// Concurrent requests on a cache miss share one probe instead of N queries.
let inFlightProbe: Promise<DbState> | null = null;

function probeDatabase(): Promise<DbState> {
  const now = Date.now();
  if (cached && now - cached.at < DB_CACHE_MS) return Promise.resolve(cached.state);
  inFlightProbe ??= runProbe().finally(() => {
    inFlightProbe = null;
  });
  return inFlightProbe;
}

async function runProbe(): Promise<DbState> {
  let state: DbState = "degraded";
  try {
    // dispatch_rate_state holds one row per channel: the smallest stable table.
    const { error } = await supabaseAdmin
      .from("dispatch_rate_state")
      .select("channel")
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    state = error ? "degraded" : "ok";
  } catch {
    state = "degraded";
  }
  cached = { at: Date.now(), state };
  return state;
}

function release(): string | null {
  const value =
    process.env.SENTRY_RELEASE?.trim() ||
    process.env.APP_RELEASE?.trim() ||
    process.env.GIT_SHA?.trim() ||
    "";
  // A release is a short identifier (git SHA / semver); never echo anything else.
  return /^[A-Za-z0-9._@+-]{1,64}$/.test(value) ? value : null;
}

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const db = await probeDatabase();
        const ok = db === "ok";
        return Response.json(
          { ok, release: release(), db, time: new Date().toISOString() },
          {
            status: ok ? 200 : 503,
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate",
              "X-Robots-Tag": "noindex, nofollow",
            },
          },
        );
      },
    },
  },
});
