// Shared secret guard for cron/dispatcher and webhook endpoints under
// /api/public/*. These routes bypass auth on the published site, so each
// handler MUST validate a shared secret before doing any work.

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const x = request.headers.get("x-cron-secret") ?? request.headers.get("x-webhook-secret");
  return x ? x.trim() : null;
}

/**
 * Throws a Response(401) if the request doesn't carry the expected shared
 * secret. Configure pg_cron / external callers to send
 *   Authorization: Bearer <secret>
 * or `x-cron-secret` / `x-webhook-secret` header.
 */
export function requireSharedSecret(
  request: Request,
  envName: "CRON_SECRET" | "BUSINESSCODE_WEBHOOK_SECRET",
): void {
  const expected = process.env[envName];
  if (!expected) {
    throw new Response(JSON.stringify({ ok: false, error: `${envName} not configured` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const got = extractToken(request);
  if (!got || !timingSafeEqualStr(got, expected)) {
    throw new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
}