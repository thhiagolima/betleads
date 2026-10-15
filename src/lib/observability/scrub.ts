// PII scrubbing shared by the Sentry client (browser) and server helpers.
//
// IMPORTANT: instrument.mjs (repo root, plain ESM loaded via `node --import`)
// keeps a duplicated copy of these rules because it cannot import TypeScript.
// scrub.test.ts runs the same cases against both implementations — keep them
// in sync when changing anything here.
//
// LGPD: never ship phone numbers, e-mails, CPFs, names, webhook payloads or
// tracking tokens to Sentry.

export const FILTERED = "[Filtered]";

const MAX_DEPTH = 8;

/** Keys (normalized: lowercase, alphanumerics only) that are always redacted. */
const SENSITIVE_EXACT_KEYS = new Set([
  "telefone",
  "phone",
  "email",
  "nome",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "username",
  "nomecompleto",
  "cpf",
  "documento",
  "celular",
  "mobile",
  "whatsapp",
  "payload",
  "rawpayload",
  "body",
  "token",
  "trackingtoken",
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "xwebhooksignature",
  "secret",
  "password",
  "apikey",
  "ipaddress",
]);

/** Substrings that mark a (normalized) key as sensitive. */
const SENSITIVE_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "authorization",
  "cookie",
  "signature",
  "cpf",
  "email",
  "phone",
  "telefone",
  "celular",
  "payload",
];

/** Sentry contexts that are SDK-generated and never contain user data. */
const SAFE_CONTEXTS = new Set([
  "runtime",
  "os",
  "device",
  "app",
  "culture",
  "trace",
  "cloud_resource",
  "browser",
  "react",
  "otel",
]);

/**
 * SDK v11 collects headers, cookies, bodies, query params, DB data and stack
 * frame variables by default (dataCollection). Restrict everything that can
 * carry PII; beforeSend scrubbing is the second line of defense.
 */
export const RESTRICTED_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: {
      allow: ["user-agent", "content-type", "content-length", "accept", "accept-language", "host"],
    },
    response: { allow: ["content-type", "content-length"] },
  },
  httpBodies: [] as Array<
    "incomingRequest" | "outgoingRequest" | "incomingResponse" | "outgoingResponse"
  >,
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_RE = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
// 000.000.000-00 (formatted CPF). Plain 11 digits fall into the phone rule.
const CPF_RE = /(?<![\w.-])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\w.-])/g;
// Brazilian/international phone numbers: +55 (11) 98046-5329, 5511980465329,
// 11980465329, 98046-5329 ... Requires at least 8 significant digits.
const PHONE_RE =
  /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)\s?|\d{2,3}[\s.-]?)?\d{4,5}[\s.-]?\d{4}(?![\w-])/g;

// Path segments that carry public tracking/webhook tokens.
const CLICK_PATH_RE = /(\/api\/public\/click\/)[^/?#\s"']+/g;
const WEBHOOK_TOKEN_PATH_RE = /(\/api\/public\/webhook\/)[^/?#\s"']+(\/[^/?#\s"']+)/g;
const UNSUBSCRIBE_PATH_RE = /((?:^|[\s"'(]|https?:\/\/[^/\s"']+)\/u\/)[^/?#\s"']+/g;
// Better Stack heartbeat URLs carry the secret in the path (/api/v1/heartbeat/<token>).
const HEARTBEAT_PATH_RE = /(\/heartbeat\/)[^/?#\s"']+/g;
// Query string values: ?a=1&b=2 -> ?a=[Filtered]&b=[Filtered]
const QUERY_VALUE_RE = /([?&][^=&#\s"']+=)[^&#\s"']*/g;

/** Replaces token-bearing path segments and every query-string value. */
export function scrubUrl(url: string): string {
  if (typeof url !== "string" || !url) return url;
  return url
    .replace(CLICK_PATH_RE, "$1:token")
    .replace(WEBHOOK_TOKEN_PATH_RE, "$1:token$2")
    .replace(UNSUBSCRIBE_PATH_RE, "$1:token")
    .replace(HEARTBEAT_PATH_RE, "$1:token")
    .replace(QUERY_VALUE_RE, `$1${FILTERED}`);
}

/** Redacts PII patterns found inside free text (messages, exception values, URLs). */
export function scrubString(value: string): string {
  if (typeof value !== "string" || !value) return value;
  return scrubUrl(value)
    .replace(JWT_RE, "[jwt]")
    .replace(BEARER_RE, `$1 ${FILTERED}`)
    .replace(EMAIL_RE, "[email]")
    .replace(CPF_RE, "[cpf]")
    .replace(PHONE_RE, "[phone]");
}

/** Deep-scrubs an arbitrary value: sensitive keys are dropped, strings are pattern-scrubbed. */
export function scrubValue<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED as T;
  if (seen.has(value as object)) return "[Circular]" as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(inner, depth + 1, seen);
  }
  return out as T;
}

type Mutable = Record<string, unknown>;

function asRecord(value: unknown): Mutable | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mutable)
    : undefined;
}

function scrubRequest(request: Mutable): void {
  if (typeof request.url === "string") request.url = scrubUrl(request.url);
  if (request.query_string !== undefined) request.query_string = FILTERED;
  if (request.cookies !== undefined) request.cookies = FILTERED;
  if (request.data !== undefined) request.data = FILTERED;
  if (request.env !== undefined) delete request.env;
  const headers = asRecord(request.headers);
  if (headers) request.headers = scrubValue(headers);
}

function scrubBreadcrumbs(breadcrumbs: unknown): void {
  if (!Array.isArray(breadcrumbs)) return;
  for (const crumb of breadcrumbs) {
    const record = asRecord(crumb);
    if (!record) continue;
    if (typeof record.message === "string") record.message = scrubString(record.message);
    const data = asRecord(record.data);
    if (data) record.data = scrubValue(data);
  }
}

/**
 * Scrubs a Sentry error/transaction event in place and returns it.
 * Works on the plain event shape so it can be reused by beforeSend and
 * beforeSendTransaction on both client and server.
 */
export function scrubEvent<T>(event: T): T {
  const ev = asRecord(event);
  if (!ev) return event;

  if (typeof ev.message === "string") ev.message = scrubString(ev.message);
  const logentry = asRecord(ev.logentry);
  if (logentry) {
    if (typeof logentry.message === "string") logentry.message = scrubString(logentry.message);
    if (Array.isArray(logentry.params)) logentry.params = scrubValue(logentry.params);
  }
  if (typeof ev.transaction === "string") ev.transaction = scrubUrl(ev.transaction);

  const exception = asRecord(ev.exception);
  if (exception && Array.isArray(exception.values)) {
    for (const item of exception.values) {
      const ex = asRecord(item);
      if (!ex) continue;
      if (typeof ex.value === "string") ex.value = scrubString(ex.value);
      // Local variables may hold leads/payloads; never ship them.
      const stacktrace = asRecord(ex.stacktrace);
      if (stacktrace && Array.isArray(stacktrace.frames)) {
        for (const frame of stacktrace.frames) {
          const fr = asRecord(frame);
          if (fr && fr.vars !== undefined) delete fr.vars;
        }
      }
    }
  }

  const request = asRecord(ev.request);
  if (request) scrubRequest(request);

  const user = asRecord(ev.user);
  if (user) {
    ev.user = user.id !== undefined && user.id !== null ? { id: user.id } : undefined;
  }

  if (ev.extra !== undefined) ev.extra = scrubValue(ev.extra);

  const tags = asRecord(ev.tags);
  if (tags) {
    for (const [key, value] of Object.entries(tags)) {
      if (isSensitiveKey(key)) tags[key] = FILTERED;
      else if (typeof value === "string") tags[key] = scrubString(value);
    }
  }

  const contexts = asRecord(ev.contexts);
  if (contexts) {
    for (const [key, value] of Object.entries(contexts)) {
      if (!SAFE_CONTEXTS.has(key)) contexts[key] = scrubValue(value);
    }
    const traceCtx = asRecord(contexts.trace);
    const traceData = traceCtx && asRecord(traceCtx.data);
    if (traceCtx && traceData) traceCtx.data = scrubSpanAttributes(traceData);
  }

  scrubBreadcrumbs(ev.breadcrumbs);

  if (Array.isArray(ev.spans)) {
    for (const span of ev.spans) {
      const record = asRecord(span);
      if (!record) continue;
      if (typeof record.description === "string") {
        record.description = scrubString(record.description);
      }
      const data = asRecord(record.data);
      if (data) record.data = scrubSpanAttributes(data);
    }
  }

  return event;
}

/** Scrubs span attributes (URLs, queries, db statements) keeping SDK metadata intact. */
export function scrubSpanAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(attributes)) {
    if (
      /(^|\.)query(_string)?$/i.test(key) ||
      (!key.startsWith("sentry.") && isSensitiveKey(key))
    ) {
      out[key] = FILTERED;
      continue;
    }
    // Some attribute shapes are { value, type }.
    const wrapped = asRecord(raw);
    if (wrapped && "value" in wrapped) {
      out[key] = { ...wrapped, value: scrubValue(wrapped.value) };
      continue;
    }
    out[key] = scrubValue(raw);
  }
  return out;
}

/** Scrubs a streamed span JSON (beforeSendSpan) in place. */
export function scrubSpan<T>(span: T): T {
  const record = asRecord(span);
  if (!record) return span;
  if (typeof record.name === "string") record.name = scrubString(record.name);
  if (typeof record.description === "string") record.description = scrubString(record.description);
  const attributes = asRecord(record.attributes);
  if (attributes) record.attributes = scrubSpanAttributes(attributes);
  const data = asRecord(record.data);
  if (data) record.data = scrubSpanAttributes(data);
  return span;
}

/** Scrubs a structured log (beforeSendLog) in place. */
export function scrubLog<T>(log: T): T {
  const record = asRecord(log);
  if (!record) return log;
  if (record.message !== undefined && record.message !== null) {
    record.message = scrubString(String(record.message));
  }
  const attributes = asRecord(record.attributes);
  if (attributes) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith("sentry.")) out[key] = scrubValue(value);
      else out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(value);
    }
    record.attributes = out;
  }
  return log;
}

/** Router control flow (redirect/notFound) and HTTP responses are not errors. */
export function isExpectedControlFlowError(error: unknown): boolean {
  if (typeof Response !== "undefined" && error instanceof Response) return true;
  const record = asRecord(error);
  if (!record) return false;
  return record.isNotFound === true || record.isRedirect === true;
}

/** Messages that are known noise and should not consume the Sentry quota. */
export const IGNORED_ERROR_MESSAGES: Array<string | RegExp> = [
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/,
  /^AbortError\b/,
  /The (operation|user) aborted a request/,
  /^aborted$/,
  /Non-Error promise rejection captured with value: undefined/,
];
