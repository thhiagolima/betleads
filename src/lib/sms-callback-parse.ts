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
export async function parseSmsCallbackPayloads(request: Request): Promise<CallbackPayload[]> {
  const url = new URL(request.url);
  const fromQuery: CallbackPayload = {};
  url.searchParams.forEach((value, key) => {
    fromQuery[key] = value;
  });

  let items: CallbackPayload[] = [];
  if (request.method !== "GET") {
    const text = (await request.text()).trim();
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

const IDENTIFYING_KEYS = ["id", "message_id", "messageId", "parceiroId", "idempotency_key", "celular"];

export function hasIdentity(payload: CallbackPayload) {
  return IDENTIFYING_KEYS.some((key) => {
    const value = payload[key];
    return (typeof value === "string" && value.trim() !== "") || typeof value === "number";
  });
}
