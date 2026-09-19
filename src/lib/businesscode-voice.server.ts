// Integração com a API de Voz da BusinessCode.
// POST https://dash.businesscode.com.br/api/v1/messaging/voice
// Headers: Authorization: Bearer <TOKEN>, Idempotency-Key: <uuid>
// Body: { to: "+55DDDNNNN", audio_url: "https://..." }

const BUSINESSCODE_VOICE_URL = "https://dash.businesscode.com.br/api/v1/messaging/voice";
const BUSINESSCODE_DISPATCH_URL = "https://dash.businesscode.com.br/api/v1/messaging/dispatches";

function normalizeBusinessCodeToken(raw: string): string {
  let t = (raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
  t = t.replace(/^Authorization\s*:\s*/i, "").trim();
  t = t.replace(/^Bearer\s+/i, "").trim();
  t = t.replace(/\s+/g, "");
  return t;
}

export function normalizeE164BR(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error("Telefone vazio");
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  if (withCountry.length < 12 || withCountry.length > 13) {
    throw new Error(`Telefone inválido: ${raw}`);
  }
  return `+${withCountry}`;
}

export type BusinessCodeVoiceResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
};

export async function callBusinessCodeVoice(
  to: string,
  audioUrl: string,
): Promise<BusinessCodeVoiceResult> {
  const rawToken = process.env.BUSINESSCODE_VOICE_TOKEN;
  const token = rawToken ? normalizeBusinessCodeToken(rawToken) : "";
  if (!token) {
    console.error("Voice BusinessCode token missing");
    return {
      ok: false,
      status: 0,
      body: { error: "BUSINESSCODE_VOICE_TOKEN não configurado" },
      idempotencyKey: "",
    };
  }
  const idempotencyKey = crypto.randomUUID();
  let res: Response;
  const maxAttempts = 6;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      console.info("Voice BusinessCode request started", { to, idempotencyKey, attempt });
      res = await fetch(BUSINESSCODE_VOICE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ to, audio_url: audioUrl }),
      });
    } catch (err) {
      console.error("Voice BusinessCode request failed before response", {
        to,
        idempotencyKey,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      return {
        ok: false,
        status: 0,
        body: { error: err instanceof Error ? err.message : String(err), attempts: attempt },
        idempotencyKey,
      };
    }
    if (res.status >= 500 && res.status <= 599 && attempt < maxAttempts) {
      console.warn("Voice BusinessCode 5xx — retrying", {
        to,
        idempotencyKey,
        status: res.status,
        attempt,
      });
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    break;
  }
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    const snippet = text.slice(0, 400);
    const looksLikeHtml = /<html|<!doctype/i.test(text);
    body = {
      non_json: true,
      content_type: res.headers.get("content-type") ?? null,
      looks_like_html: looksLikeHtml,
      snippet,
    };
  }
  console.info("Voice BusinessCode response received", {
    to,
    idempotencyKey,
    status: res.status,
    ok: res.ok,
    attempts: attempt,
    body,
  });
  return { ok: res.ok, status: res.status, body, idempotencyKey };
}

// ============================================================
// Consulta de status de um dispatch já enviado
// GET /api/v1/messaging/dispatches/{id}
// ============================================================
export type BusinessCodeDispatchStatus = {
  ok: boolean;
  status: number;
  body: unknown;
};

export async function fetchBusinessCodeDispatchStatus(
  dispatchId: number | string,
): Promise<BusinessCodeDispatchStatus> {
  const rawToken = process.env.BUSINESSCODE_VOICE_TOKEN;
  const token = rawToken ? normalizeBusinessCodeToken(rawToken) : "";
  if (!token) {
    return {
      ok: false,
      status: 0,
      body: { error: "BUSINESSCODE_VOICE_TOKEN não configurado" },
    };
  }
  let res: Response;
  try {
    res = await fetch(`${BUSINESSCODE_DISPATCH_URL}/${dispatchId}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { non_json: true, snippet: text.slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, body };
}
