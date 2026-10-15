// Sentry bootstrap for the Node server (OBS-02).
//
// Loaded BEFORE the app via:
//   node --import ./instrument.mjs .output/server/index.mjs
//
// Sentry is only initialized when SENTRY_DSN is non-empty; otherwise this file
// is a no-op and the server behaves exactly as before.
//
// The scrubbing helpers below are a plain-JS copy of
// src/lib/observability/scrub.ts (this file cannot import TypeScript).
// src/lib/observability/scrub.test.ts runs the same cases against both copies,
// so keep them in sync.
//
// The app code reports errors through src/lib/observability/sentry.server.ts,
// which uses @sentry/core's global carrier. That only works when the bundled
// @sentry/core and this @sentry/node share the EXACT same version — both are
// pinned in package.json and the Dockerfile installs the same @sentry/node.

export const FILTERED = "[Filtered]";

const MAX_DEPTH = 8;

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

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_RE = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
const CPF_RE = /(?<![\w.-])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\w.-])/g;
const PHONE_RE =
  /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)\s?|\d{2,3}[\s.-]?)?\d{4,5}[\s.-]?\d{4}(?![\w-])/g;
const CLICK_PATH_RE = /(\/api\/public\/click\/)[^/?#\s"']+/g;
const WEBHOOK_TOKEN_PATH_RE = /(\/api\/public\/webhook\/)[^/?#\s"']+(\/[^/?#\s"']+)/g;
const UNSUBSCRIBE_PATH_RE = /((?:^|[\s"'(]|https?:\/\/[^/\s"']+)\/u\/)[^/?#\s"']+/g;
// Better Stack heartbeat URLs carry the secret in the path (/api/v1/heartbeat/<token>).
const HEARTBEAT_PATH_RE = /(\/heartbeat\/)[^/?#\s"']+/g;
const QUERY_VALUE_RE = /([?&][^=&#\s"']+=)[^&#\s"']*/g;

// Same as RESTRICTED_DATA_COLLECTION in scrub.ts (SDK v11 collects almost
// everything by default; sendDefaultPii no longer exists in v11).
export const RESTRICTED_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: {
      allow: ["user-agent", "content-type", "content-length", "accept", "accept-language", "host"],
    },
    response: { allow: ["content-type", "content-length"] },
  },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function scrubUrl(url) {
  if (typeof url !== "string" || !url) return url;
  return url
    .replace(CLICK_PATH_RE, "$1:token")
    .replace(WEBHOOK_TOKEN_PATH_RE, "$1:token$2")
    .replace(UNSUBSCRIBE_PATH_RE, "$1:token")
    .replace(HEARTBEAT_PATH_RE, "$1:token")
    .replace(QUERY_VALUE_RE, `$1${FILTERED}`);
}

export function scrubString(value) {
  if (typeof value !== "string" || !value) return value;
  return scrubUrl(value)
    .replace(JWT_RE, "[jwt]")
    .replace(BEARER_RE, `$1 ${FILTERED}`)
    .replace(EMAIL_RE, "[email]")
    .replace(CPF_RE, "[cpf]")
    .replace(PHONE_RE, "[phone]");
}

export function scrubValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(inner, depth + 1, seen);
  }
  return out;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function scrubRequest(request) {
  if (typeof request.url === "string") request.url = scrubUrl(request.url);
  if (request.query_string !== undefined) request.query_string = FILTERED;
  if (request.cookies !== undefined) request.cookies = FILTERED;
  if (request.data !== undefined) request.data = FILTERED;
  if (request.env !== undefined) delete request.env;
  const headers = asRecord(request.headers);
  if (headers) request.headers = scrubValue(headers);
}

function scrubBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs)) return;
  for (const crumb of breadcrumbs) {
    const record = asRecord(crumb);
    if (!record) continue;
    if (typeof record.message === "string") record.message = scrubString(record.message);
    const data = asRecord(record.data);
    if (data) record.data = scrubValue(data);
  }
}

export function scrubSpanAttributes(attributes) {
  const out = {};
  for (const [key, raw] of Object.entries(attributes)) {
    if (
      /(^|\.)query(_string)?$/i.test(key) ||
      (!key.startsWith("sentry.") && isSensitiveKey(key))
    ) {
      out[key] = FILTERED;
      continue;
    }
    const wrapped = asRecord(raw);
    if (wrapped && "value" in wrapped) {
      out[key] = { ...wrapped, value: scrubValue(wrapped.value) };
      continue;
    }
    out[key] = scrubValue(raw);
  }
  return out;
}

export function scrubEvent(event) {
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
  if (user) ev.user = user.id !== undefined && user.id !== null ? { id: user.id } : undefined;

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

export function scrubSpan(span) {
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

export function scrubLog(log) {
  const record = asRecord(log);
  if (!record) return log;
  if (record.message !== undefined && record.message !== null) {
    record.message = scrubString(String(record.message));
  }
  const attributes = asRecord(record.attributes);
  if (attributes) {
    const out = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith("sentry.")) out[key] = scrubValue(value);
      else out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(value);
    }
    record.attributes = out;
  }
  return log;
}

function parseSampleRate(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

// Expected noise on a public-facing server: client disconnects/aborts.
const IGNORED_SERVER_ERRORS = [/^aborted$/, /ECONNRESET/, /EPIPE/, /The operation was aborted/];

function safe(fn, fallback) {
  return (item, ...rest) => {
    try {
      return fn(item, ...rest);
    } catch {
      // Never let a scrubbing bug leak data: drop the item instead.
      return fallback;
    }
  };
}

const dsn = (process.env.SENTRY_DSN ?? "").trim();

if (dsn) {
  // Loaded lazily so a server without SENTRY_DSN pays no startup cost.
  // A missing or broken SDK must never take the app down: log and run without it.
  let Sentry = null;
  try {
    Sentry = await import("@sentry/node");
  } catch (error) {
    console.error("[sentry] @sentry/node indisponivel; seguindo sem Sentry", error);
  }
  Sentry?.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    // Logs are on by default in SDK v11; kept explicit for older readers of this file.
    enableLogs: true,
    // sendDefaultPii was replaced by dataCollection in SDK v11; both are set so
    // the intent stays explicit (an unknown option is ignored).
    sendDefaultPii: false,
    dataCollection: RESTRICTED_DATA_COLLECTION,
    ignoreErrors: IGNORED_SERVER_ERRORS,
    beforeSend: safe((event) => scrubEvent(event), null),
    // No beforeSendTransaction: SDK v11 streams spans by default (traceLifecycle
    // "stream") and ignores it with a startup warning. Spans/transactions are
    // scrubbed by beforeSendSpan below.
    // Spans cannot be dropped here; on failure strip everything identifying.
    beforeSendSpan: (span) => {
      try {
        return scrubSpan(span);
      } catch {
        return { ...span, name: FILTERED, attributes: {} };
      }
    },
    beforeSendLog: safe((log) => scrubLog(log), null),
    beforeBreadcrumb: safe((breadcrumb) => {
      scrubBreadcrumbs([breadcrumb]);
      return breadcrumb;
    }, null),
  });
}
