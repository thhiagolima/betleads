// Parsing of Short Brasil SMS callbacks (status, DLR, replies).

export type CallbackPayload = Record<string, unknown>;

export const SECRET_KEYS = new Set(["token", "secret", "webhook_secret"]);

function withoutSecrets(payload: CallbackPayload): CallbackPayload {
  const clean: CallbackPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SECRET_KEYS.has(key)) clean[key] = value;
  }
  return clean;
}

function isObject(value: unknown): value is CallbackPayload {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** JSON body: `{ lote: [...] }`, a bare array or a single object. */
function itemsFromJson(parsed: unknown): CallbackPayload[] | null {
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (isObject(parsed)) {
    if (Array.isArray(parsed.lote)) return parsed.lote.filter(isObject);
    if (typeof parsed.lote === "string") {
      try {
        return itemsFromJson(JSON.parse(parsed.lote));
      } catch {
        return null;
      }
    }
    return [parsed];
  }
  return null;
}

function itemsFromForm(text: string): CallbackPayload[] {
  const params = new URLSearchParams(text);
  const payload: CallbackPayload = {};
  params.forEach((value, key) => {
    payload[key] = value;
  });
  // Some senders post `lote=<json>` (or a JSON document as the only key).
  for (const candidate of [payload.lote, ...Object.keys(payload)]) {
    if (typeof candidate !== "string" || !/^\s*[[{]/.test(candidate)) continue;
    try {
      const items = itemsFromJson(JSON.parse(candidate));
      if (items?.length) return items;
    } catch {
      // not JSON
    }
  }
  return [payload];
}

/**
 * The provider documents GET (query string) for single callbacks and a JSON
 * `{ lote: [...] }` for bulk ones, but POSTs in other shapes were observed
 * (payload reached us as only `{token}`), so accept every shape: the query
 * string is merged into each body item, and the body may be JSON, a JSON
 * array, form-urlencoded, `lote=<json>` or a raw query string.
 */
export async function parseSmsCallbackPayloads(
  request: Request,
  onBody?: (text: string) => void,
): Promise<CallbackPayload[]> {
  const url = new URL(request.url);
  const fromQuery: CallbackPayload = {};
  url.searchParams.forEach((value, key) => {
    fromQuery[key] = value;
  });

  let items: CallbackPayload[] = [];
  if (request.method !== "GET") {
    const text = (await request.text()).trim();
    onBody?.(text);
    if (text) {
      let parsed: CallbackPayload[] | null = null;
      if (/^[[{]/.test(text)) {
        try {
          parsed = itemsFromJson(JSON.parse(text));
        } catch {
          parsed = null;
        }
      }
      items = parsed ?? itemsFromForm(text);
    }
  }
  if (!items.length) items = [{}];
  return items.map((item) => withoutSecrets({ ...fromQuery, ...item }));
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return depth > 2 ? `array(${value.length})` : { array: value.length, first: shapeOf(value[0], depth + 1) };
  }
  if (value && typeof value === "object") {
    if (depth > 2) return "object";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 15);
    return Object.fromEntries(entries.map(([key, inner]) => [key, shapeOf(inner, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

/**
 * Diagnostic description of a callback body we could not read: structure
 * (types and key names) plus a short preview with secrets removed and every
 * run of 6+ digits masked (phones, ids). Never contains the webhook token.
 */
export function describeCallbackBody(text: string) {
  let shape: unknown = "unparseable";
  try {
    shape = shapeOf(JSON.parse(text));
  } catch {
    shape = "not_json";
  }
  const preview = text
    .slice(0, 300)
    .replace(/("?(?:token|secret|webhook_secret)"?\s*[:=]\s*"?)[^"&,}\s]+/gi, "$1***")
    .replace(/\d{6,}/g, (digits) => "#".repeat(Math.min(digits.length, 12)));
  return { length: text.length, shape, preview };
}

const IDENTIFYING_KEYS = ["id", "message_id", "messageId", "parceiroId", "idempotency_key", "celular"];

export function hasIdentity(payload: CallbackPayload) {
  return IDENTIFYING_KEYS.some((key) => {
    const value = payload[key];
    return (typeof value === "string" && value.trim() !== "") || typeof value === "number";
  });
}
