// What a failed provider call tells us about delivery (B1).
//
//   misconfigured   : credentials/URL missing; nothing was sent. Never retried
//                     silently: the worker fails the item and reports it.
//   not_sent        : the request provably never reached the provider (DNS,
//                     connection refused/unreachable, connect timeout, local
//                     pre-check failed). Safe to retry.
//   outcome_unknown : the request may have reached the provider (client
//                     timeout/abort, connection reset, socket hang up after the
//                     body was written). Must be treated as POSSIBLY SENT: Short
//                     Brasil does not deduplicate by external_id and Infobip
//                     voice has no idempotency header, so a blind retry can
//                     deliver twice.
//   provider_account: the provider answered, but refused the ACCOUNT, not the
//                     lead (Short Brasil 101 auth / 505 no balance, HTTP
//                     401/402/403). Nothing was sent; every lead would get the
//                     same answer. Never consumes a lead attempt: the item is
//                     deferred and the SMS circuit breaker opens
//                     (src/lib/sms-provider-breaker.server.ts).
//   insufficient_balance: the HOUSE's own wallet refused the reservation
//                     before the provider was ever called. Always per-house,
//                     never pauses the channel for other tenants, never
//                     consumes an attempt:
//                       - journeys skip the step and advance;
//                       - SMS/e-mail flows reschedule just this one item
//                         15 min out; call flows skip the block and move on;
//                       - SMS campaigns stop at that recipient and pause
//                         ('pausada', "Saldo insuficiente") until "Retomar";
//                         e-mail campaigns pause the same way;
//                       - the voice queue keeps the house's due items ready
//                         (never failed) and moves them 15 min out; a
//                         "Disparar agora" call is failed instead.
//                     The house gets the hourly no-balance e-mail. Distinct
//                     from `provider_account`'s "no_balance" reason, which is
//                     the provider's OWN account (Short Brasil) out of
//                     balance.
//   expert_cap / expert_inactive: Área do Expert — the reservation of an
//                     expert campaign send was refused because the expert hit
//                     the monthly cap (or was deactivated). Nothing was sent
//                     nor charged. Only that expert's campaign/items pause;
//                     never the house's no-balance alert or backoff.
//
// Pure module (no I/O): imported by the SMS, voice and e-mail adapters.

export type ProviderErrorKind =
  | "misconfigured"
  | "not_sent"
  | "outcome_unknown"
  | "provider_account"
  | "insufficient_balance"
  | "expert_cap"
  | "expert_inactive";

// Failures that happen before a TCP connection exists (nothing was written).
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
  "ERR_INVALID_ARG_TYPE",
]);

const NOT_SENT_MESSAGE =
  /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|getaddrinfo|invalid url/i;

function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const inner of errors) {
        const innerCode = (inner as { code?: unknown } | null)?.code;
        if (typeof innerCode === "string") codes.push(innerCode);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) parts.push(current.message);
    else if (typeof current === "string") parts.push(current);
    current = current && typeof current === "object" ? (current as { cause?: unknown }).cause : null;
  }
  return parts.join(" | ");
}

/**
 * Classifies an exception thrown by fetch() (or a wrapper) for a provider
 * call. Anything that is not provably "never left" is `outcome_unknown`.
 */
export function transportErrorKind(
  error: unknown,
): Exclude<
  ProviderErrorKind,
  "misconfigured" | "provider_account" | "insufficient_balance" | "expert_cap" | "expert_inactive"
> {
  const codes = codesOf(error);
  if (codes.some((code) => NOT_SENT_CODES.has(code))) return "not_sent";
  // A timeout/abort/reset anywhere in the chain wins over a message match.
  if (codes.length === 0 && NOT_SENT_MESSAGE.test(messagesOf(error))) return "not_sent";
  return "outcome_unknown";
}

export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return (
    value === "misconfigured" ||
    value === "not_sent" ||
    value === "outcome_unknown" ||
    value === "provider_account" ||
    value === "insufficient_balance"
  );
}

export type ProviderAccountReason = "auth" | "no_balance";

function appStatusOf(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).status;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

// Incident 27-28/10/2026: the provider answered `{"status":5,"statusDetalhe":
// "Saldo insuficiente"}` for 12h; 5 was not listed, so 4,702 refusals were
// logged as sent and billed.
const SHORT_BRASIL_NO_BALANCE_CODES = new Set([5, 505]);
const SHORT_BRASIL_KNOWN_ERROR_CODES = new Set([5, 101, 303, 404, 505]);

function hasProviderMessageId(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const id = (body as Record<string, unknown>).id;
  return (typeof id === "string" && id.length > 0) || typeof id === "number";
}

/**
 * Short Brasil answers HTTP 200 even when it refuses a message: the refusal
 * carries a numeric `status` and no message `id` (an accepted message has an
 * `id` and no `status`). A code we do not know is still a refusal when there
 * is no id — never a silent success.
 */
export function isShortBrasilRefusal(body: unknown): boolean {
  const app = appStatusOf(body);
  if (app === null) return false;
  if (SHORT_BRASIL_KNOWN_ERROR_CODES.has(app)) return true;
  return !hasProviderMessageId(body);
}

/** A refusal with a code outside the known list (worth an alert). */
export function isUnknownShortBrasilRefusal(body: unknown): boolean {
  const app = appStatusOf(body);
  return app !== null && !SHORT_BRASIL_KNOWN_ERROR_CODES.has(app) && isShortBrasilRefusal(body);
}

/**
 * Account-level refusal of an SMS provider answer (HTTP status + parsed body),
 * or null when the answer is about the lead / not a refusal. Incident
 * 15/10/2026: Short Brasil answered `{"status":101}` (auth) for a route with
 * no balance, so 101 and 5/505 are treated alike.
 */
export function smsProviderAccountReason(
  httpStatus: number,
  body: unknown,
): ProviderAccountReason | null {
  const app = appStatusOf(body);
  if ((app !== null && SHORT_BRASIL_NO_BALANCE_CODES.has(app)) || httpStatus === 402)
    return "no_balance";
  if (app === 101 || httpStatus === 401 || httpStatus === 403) return "auth";
  return null;
}
