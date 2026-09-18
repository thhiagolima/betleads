import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

// Callback Short Brasil SMS.
// URL sugerida:
//   https://seu-dominio.com/api/public/sms-webhook?token=<SHORT_BRASIL_WEBHOOK_SECRET>
//
// A Short Brasil envia callbacks Single via HTTP/GET e pode enviar callbacks
// Bulk em JSON com { lote: [...] }. Sempre respondemos 200 depois da
// autenticacao para evitar retentativas em loop; erros internos ficam nos logs.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-webhook-secret, x-cron-secret",
  "Access-Control-Max-Age": "86400",
} as const;

type CallbackPayload = Record<string, unknown>;

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  const queryToken =
    url.searchParams.get("token") ??
    url.searchParams.get("secret") ??
    url.searchParams.get("webhook_secret");
  if (queryToken) return queryToken.trim();

  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const headerToken =
    request.headers.get("x-webhook-secret") ?? request.headers.get("x-cron-secret");
  return headerToken ? headerToken.trim() : null;
}

function authorizeCallback(request: Request): Response | null {
  const expected =
    process.env.SHORT_BRASIL_WEBHOOK_SECRET ?? process.env.BUSINESSCODE_WEBHOOK_SECRET;
  if (!expected) {
    return Response.json(
      { ok: false, error: "SHORT_BRASIL_WEBHOOK_SECRET not configured" },
      { status: 500, headers: CORS },
    );
  }
  const got = extractToken(request);
  if (!got || !timingSafeEqualStr(got, expected)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: CORS });
  }
  return null;
}

function pickStr(obj: CallbackPayload, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function normalizeShortBrasilStatus(payload: CallbackPayload): string {
  const confirmation = pickStr(payload, "confirmacaoDescricao", "statusConfirmacao");
  if (confirmation) {
    const s = confirmation.toUpperCase();
    if (s === "4" || s === "CONFIRMADO") return "delivered";
    if (s === "5" || s === "NAO_ENTREGUE" || s === "NÃO_ENTREGUE") return "failed";
    if (s === "AGUARDANDO") return "sent";
  }

  const carrier = pickStr(payload, "statusDescricao", "statusOperadora");
  if (carrier) {
    const s = carrier.toUpperCase();
    if (s === "3" || s === "REJEITADA" || s === "DESCONHECIDO") return "failed";
    if (s === "2" || s === "AGENDADA" || s === "ENCAMINHADA" || s === "ENVIADA") {
      return "sent";
    }
  }

  if (pickStr(payload, "resposta", "respostaDescricao", "respostaData")) return "replied";

  const generic = pickStr(payload, "status", "state", "event");
  if (!generic) return "unknown";
  const s = generic.toLowerCase();
  if (["delivered", "entregue", "delivrd", "received"].includes(s)) return "delivered";
  if (["failed", "falhou", "error", "undelivered", "rejected"].includes(s)) return "failed";
  if (["sent", "enviado", "queued", "accepted", "pending"].includes(s)) return "sent";
  return s;
}

function parseShortBrasilDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const br = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  const date = br
    ? new Date(`${br[1]}-${br[2]}-${br[3]}T${br[4]}:${br[5]}:${br[6]}-03:00`)
    : new Date(trimmed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function deliveredAtFor(status: string, payload: CallbackPayload): string | null {
  if (status !== "delivered" && status !== "replied") return null;
  return (
    parseShortBrasilDate(
      pickStr(
        payload,
        "confirmacaoData",
        "respostaData",
        "statusData",
        "delivered_at",
        "deliveredAt",
        "timestamp",
        "date",
      ),
    ) ?? new Date().toISOString()
  );
}

async function parsePayloads(request: Request): Promise<CallbackPayload[]> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const payload: CallbackPayload = {};
    url.searchParams.forEach((value, key) => {
      if (!["token", "secret", "webhook_secret"].includes(key)) payload[key] = value;
    });
    return [payload];
  }

  const contentType = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (!text) return [{}];

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const payload: CallbackPayload = {};
    params.forEach((value, key) => {
      payload[key] = value;
    });
    return [payload];
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.lote)) {
      return parsed.lote.filter((item: unknown): item is CallbackPayload => {
        return !!item && typeof item === "object" && !Array.isArray(item);
      });
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return [parsed as CallbackPayload];
    }
  } catch {
    // Cai no retorno vazio abaixo.
  }
  return [{}];
}

async function updateFromPayload(payload: CallbackPayload): Promise<boolean> {
  const providerMessageId = pickStr(payload, "id", "message_id", "messageId", "sms_id", "smsId");
  const idempotencyKey = pickStr(payload, "parceiroId", "idempotency_key", "idempotencyKey");
  const status = normalizeShortBrasilStatus(payload);
  const deliveredAt = deliveredAtFor(status, payload);
  const errorMsg =
    status === "failed"
      ? pickStr(
          payload,
          "confirmacaoDescricao",
          "statusDescricao",
          "error",
          "error_message",
          "reason",
        )
      : null;

  const patch: {
    delivery_status: string;
    last_callback: Json;
    delivered_at?: string;
    error?: string | null;
  } = {
    delivery_status: status === "replied" ? "delivered" : status,
    last_callback: payload as Json,
  };
  if (deliveredAt) patch.delivered_at = deliveredAt;
  if (errorMsg) patch.error = errorMsg;

  let matched = false;
  if (providerMessageId) {
    const { data } = await supabaseAdmin
      .from("sms_send_logs")
      .update(patch)
      .eq("provider_message_id", providerMessageId)
      .select("id");
    matched = !!data && data.length > 0;
  }
  if (!matched && idempotencyKey) {
    const { data } = await supabaseAdmin
      .from("sms_send_logs")
      .update(patch)
      .eq("idempotency_key", idempotencyKey)
      .select("id");
    matched = !!data && data.length > 0;
  }

  if (!matched) {
    await supabaseAdmin.from("sms_send_logs").insert({
      to_phone: pickStr(payload, "celular", "to", "phone", "destination") ?? "unknown",
      content: pickStr(payload, "mensagem") ?? "(callback sem envio correspondente)",
      status: status === "failed" ? "error" : "sent",
      provider: "short-brasil",
      provider_response: payload as Json,
      error: errorMsg,
      provider_message_id: providerMessageId,
      idempotency_key: idempotencyKey,
      delivery_status: status === "replied" ? "delivered" : status,
      delivered_at: deliveredAt,
      last_callback: payload as Json,
      trigger_name: "callback-orphan",
    });
  }
  return matched;
}

async function handleCallback(request: Request): Promise<Response> {
  const unauthorized = authorizeCallback(request);
  if (unauthorized) return unauthorized;

  let processed = 0;
  let matched = 0;
  try {
    const payloads = await parsePayloads(request);
    for (const payload of payloads) {
      if (!payload || Object.keys(payload).length === 0) continue;
      processed++;
      if (await updateFromPayload(payload)) matched++;
    }
  } catch (err) {
    console.error("sms-webhook handler error:", err);
  }

  return Response.json({ received: true, processed, matched }, { status: 200, headers: CORS });
}

export const Route = createFileRoute("/api/public/sms-webhook")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => handleCallback(request),
      POST: async ({ request }) => handleCallback(request),
    },
  },
});
