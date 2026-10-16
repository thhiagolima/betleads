// Authentication between Evolution API and the inbound webhook
// (/api/public/evolution-webhook). Server-only.
//
// The shared secret is EVOLUTION_WEBHOOK_SECRET and nothing else: never the
// global EVOLUTION_API_KEY (which controls every WhatsApp instance). It travels
// only in a request header that Evolution v2 sends with each event — configured
// through the `headers` field of POST /webhook/set/{instance} — so it never
// appears in URLs, access logs or in the webhook config returned to a browser.
//
// The header is `x-webhook-secret`. We do not use `jwt_key`/Authorization in
// the Evolution config because Evolution treats `headers.jwt_key` specially.
// `Authorization: Bearer <secret>` is still accepted for manual tooling.

export const EVOLUTION_WEBHOOK_PATH = "/api/public/evolution-webhook";
export const EVOLUTION_WEBHOOK_SECRET_HEADER = "x-webhook-secret";

function readSecret(): string {
  return (process.env.EVOLUTION_WEBHOOK_SECRET ?? "").trim().replace(/^['"]|['"]$/g, "");
}

/** The configured webhook secret; throws when it is not set. */
export function evolutionWebhookSecret(): string {
  const secret = readSecret();
  if (!secret) {
    throw new Error(
      "EVOLUTION_WEBHOOK_SECRET não está configurado no servidor. Defina um segredo próprio " +
        "(não use a EVOLUTION_API_KEY) antes de registrar webhooks na Evolution.",
    );
  }
  return secret;
}

function publicAppUrl(): string {
  const url = process.env.PUBLIC_APP_URL ?? process.env.APP_URL;
  if (!url) throw new Error("PUBLIC_APP_URL is required to register Evolution webhooks");
  return url.trim().replace(/\/+$/, "");
}

/** Public webhook URL (no credentials in it — safe to log/display). */
export function evolutionWebhookUrl(): string {
  return `${publicAppUrl()}${EVOLUTION_WEBHOOK_PATH}`;
}

/** Body of `webhook` for Evolution v2 POST /webhook/set/{instance}. */
export function evolutionWebhookTarget(events: string[]) {
  const secret = evolutionWebhookSecret();
  return {
    enabled: true,
    url: evolutionWebhookUrl(),
    headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: secret },
    byEvents: false,
    base64: false,
    events,
  };
}

/** Full request body for POST /webhook/set/{instance} (nested + flat formats). */
export function evolutionWebhookSetBody(events: string[]) {
  const webhook = evolutionWebhookTarget(events);
  return {
    webhook,
    // Some builds accept the "flat" format.
    enabled: webhook.enabled,
    url: webhook.url,
    headers: webhook.headers,
    events: webhook.events,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only when the request carries EVOLUTION_WEBHOOK_SECRET in the
 * x-webhook-secret header or as `Authorization: Bearer`. The query string is
 * deliberately ignored. Always false when the secret is not configured.
 */
export function isAuthorizedEvolutionWebhook(request: Request): boolean {
  const expected = readSecret();
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? "";
  const header = request.headers.get(EVOLUTION_WEBHOOK_SECRET_HEADER)?.trim() ?? "";
  return constantTimeEqual(header, expected) || constantTimeEqual(bearer, expected);
}
