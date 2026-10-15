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
//
// Pure module (no I/O): imported by the SMS, voice and e-mail adapters.

export type ProviderErrorKind = "misconfigured" | "not_sent" | "outcome_unknown";

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
export function transportErrorKind(error: unknown): Exclude<ProviderErrorKind, "misconfigured"> {
  const codes = codesOf(error);
  if (codes.some((code) => NOT_SENT_CODES.has(code))) return "not_sent";
  // A timeout/abort/reset anywhere in the chain wins over a message match.
  if (codes.length === 0 && NOT_SENT_MESSAGE.test(messagesOf(error))) return "not_sent";
  return "outcome_unknown";
}

export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return value === "misconfigured" || value === "not_sent" || value === "outcome_unknown";
}
