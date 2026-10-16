import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { ACCEPTED_SMS_STATUSES } from "@/lib/campaign-recipients.server";
import {
  SECRET_KEYS,
  describeCallbackBody,
  hasIdentity,
  parseSmsCallbackPayloads,
  type CallbackPayload,
} from "@/lib/sms-callback-parse";

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
  const expected = process.env.SHORT_BRASIL_WEBHOOK_SECRET;
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



let lastUnrecognizedLogAt = 0;

/** Logs the shape (never the values) of a callback we could not read. */
function logUnrecognizedShape(
  request: Request,
  payloads: CallbackPayload[],
  bodyText: string,
) {
  const now = Date.now();
  if (now - lastUnrecognizedLogAt < 60_000) return;
  lastUnrecognizedLogAt = now;
  const url = new URL(request.url);
  console.warn("[sms-webhook] callback without identifiable fields", {
    method: request.method,
    contentType: request.headers.get("content-type"),
    queryKeys: [...url.searchParams.keys()].filter((key) => !SECRET_KEYS.has(key)),
    payloadKeys: payloads.map((payload) => Object.keys(payload).slice(0, 20)),
    body: describeCallbackBody(bodyText),
  });
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
    // A delivery key can have older 'error' rows (refunded attempts) besides
    // the accepted one: update only the most recent accepted row.
    const { data: candidates } = await supabaseAdmin
      .from("sms_send_logs")
      .select("id")
      .eq("idempotency_key", idempotencyKey)
      .in("status", ACCEPTED_SMS_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1);
    const targetId = candidates?.[0]?.id;
    if (targetId) {
      const { data } = await supabaseAdmin
        .from("sms_send_logs")
        .update(patch)
        .eq("id", targetId)
        .select("id");
      matched = !!data && data.length > 0;
    }
  }

  // A dispatch uses `${sms_log.idempotency_key}:position`; this carries the
  // provider's confirmed delivery back to the conversion report without ever
  // treating accepted/sent as delivered.
  if (idempotencyKey && ["delivered", "failed"].includes(patch.delivery_status)) {
    await (supabaseAdmin as any)
      .from("link_dispatches")
      .update({ delivery_status: patch.delivery_status, delivered_at: deliveredAt })
      .like("idempotency_key", `${idempotencyKey}:%`);
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
  let unidentified = 0;
  try {
    let bodyText = "";
    const payloads = await parseSmsCallbackPayloads(request, (text) => {
      bodyText = text;
    });
    for (const payload of payloads) {
      // Without any id there is nothing to match or keep: recording it only
      // created ~180k empty "callback-orphan" rows per day.
      if (!payload || !hasIdentity(payload)) {
        unidentified++;
        continue;
      }
      processed++;
      if (await updateFromPayload(payload)) matched++;
    }
    if (unidentified > 0) logUnrecognizedShape(request, payloads, bodyText);
  } catch (err) {
    console.error("sms-webhook handler error:", err);
  }

  return Response.json(
    { received: true, processed, matched, unidentified },
    { status: 200, headers: CORS },
  );
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
