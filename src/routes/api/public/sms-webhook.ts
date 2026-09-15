import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

// Webhook receiver para callbacks de status da BusinessCode SMS.
// URL: https://project--<project-id>.lovable.app/api/public/sms-webhook
//
// Sempre respondemos 200 — evita re-tentativas em loop. Erros internos
// ficam apenas nos logs do servidor.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function pickStr(obj: any, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function normalizeStatus(raw: string | null): string {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (
    ["delivered", "entregue", "delivrd", "received", "message.delivered", "message.sent"].includes(
      s,
    )
  )
    return "delivered";
  if (
    [
      "failed",
      "falhou",
      "error",
      "undeliverable",
      "undelivered",
      "rejected",
      "message.failed",
      "message.undelivered",
    ].includes(s)
  )
    return "failed";
  if (
    ["sent", "enviado", "queued", "accepted", "submitted", "message.queued", "pending"].includes(s)
  )
    return "sent";
  return s;
}

export const Route = createFileRoute("/api/public/sms-webhook")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ request }) => {
        try { requireSharedSecret(request, "BUSINESSCODE_WEBHOOK_SECRET"); } catch (r) { return r as Response; }
        let payload: any = null;
        try {
          const text = await request.text();
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = {};
        }

        try {
          const providerMessageId = pickStr(
            payload,
            "id",
            "message_id",
            "messageId",
            "sms_id",
            "smsId",
          );
          const idempotencyKey = pickStr(payload, "idempotency_key", "idempotencyKey");
          const status = normalizeStatus(pickStr(payload, "status", "state", "event"));
          const errorMsg = pickStr(payload, "error", "error_message", "reason");
          const deliveredAtRaw = pickStr(
            payload,
            "delivered_at",
            "deliveredAt",
            "timestamp",
            "date",
          );
          const deliveredAt =
            status === "delivered" && deliveredAtRaw
              ? new Date(deliveredAtRaw).toISOString()
              : status === "delivered"
              ? new Date().toISOString()
              : null;

          const patch: {
            delivery_status: string;
            last_callback: any;
            delivered_at?: string;
            error?: string;
          } = {
            delivery_status: status,
            last_callback: payload,
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
            // Sem match — grava como log órfão pra auditoria.
            await supabaseAdmin.from("sms_send_logs").insert({
              to_phone: pickStr(payload, "to", "phone", "destination") ?? "unknown",
              content: "(callback sem envio correspondente)",
              status: status === "delivered" ? "sent" : "error",
              provider: "businesscode",
              provider_response: payload,
              error: errorMsg,
              provider_message_id: providerMessageId,
              delivery_status: status,
              delivered_at: deliveredAt,
              last_callback: payload,
              trigger_name: "callback-orphan",
            });
          }
        } catch (err) {
          console.error("sms-webhook handler error:", err);
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      },
    },
  },
});