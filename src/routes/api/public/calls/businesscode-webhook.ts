// Webhook público para callbacks de status da BusinessCode Voice.
// Cadastrar na BusinessCode: https://betleads.io/api/public/calls/businesscode-webhook

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { handleCallCompletion } from "@/lib/call-flows.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

const PayloadSchema = z.object({
  idempotency_key: z.string().max(200).optional(),
  provider_call_id: z.string().max(200).optional(),
  message_id: z.string().max(200).optional(),
  status: z
    .enum([
      "answered",
      "not_answered",
      "busy",
      "failed",
      "completed",
      "calling",
      "delivered",
      "undelivered",
    ])
    .optional(),
  duration_seconds: z.number().int().min(0).max(86400).optional(),
  recording_url: z.string().url().max(1000).optional(),
  error_message: z.string().max(2000).optional(),
});

function mapHistoryStatus(s: string | undefined): string {
  switch (s) {
    case "answered":
    case "completed":
    case "delivered":
      return "completed";
    case "calling":
      return "pending";
    case "not_answered":
    case "busy":
    case "failed":
    case "undelivered":
      return "failed";
    default:
      return "completed";
  }
}

function mapQueueStatus(s: string | undefined): string | null {
  switch (s) {
    case "calling":
      return "calling";
    case "answered":
    case "completed":
    case "delivered":
      return "completed";
    case "not_answered":
    case "busy":
    case "failed":
    case "undelivered":
      return "failed";
    default:
      return null;
  }
}

export const Route = createFileRoute("/api/public/calls/businesscode-webhook")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        }),
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "BUSINESSCODE_WEBHOOK_SECRET");
        } catch (r) {
          return r as Response;
        }
        const cors = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: cors,
          });
        }

        const parsed = PayloadSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn("[businesscode voice webhook] payload inválido", parsed.error.flatten());
          return new Response(
            JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
            { status: 400, headers: cors },
          );
        }
        const p = parsed.data;
        console.log("[businesscode voice webhook] recebido", p);

        const providerCallId =
          p.provider_call_id ?? p.idempotency_key ?? p.message_id ?? null;

        if (!providerCallId) {
          console.warn("[businesscode voice webhook] sem identificador, ignorando");
          return new Response(JSON.stringify({ ok: true, skipped: true }), {
            status: 200,
            headers: cors,
          });
        }

        // Localiza histórico pela idempotency key
        const { data: history } = await supabaseAdmin
          .from("call_history")
          .select("id, call_queue_id, lead_id, script_id")
          .eq("provider_call_id", providerCallId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const newHistoryStatus = mapHistoryStatus(p.status);

        if (history) {
          const { error: hErr } = await supabaseAdmin
            .from("call_history")
            .update({
              status: newHistoryStatus as any,
              duration_seconds: p.duration_seconds ?? null,
              recording_url: p.recording_url ?? null,
              error_message: p.error_message ?? null,
            } as any)
            .eq("id", history.id);
          if (hErr)
            console.error("[businesscode voice webhook] erro histórico:", hErr.message);

          if (history.call_queue_id) {
            const newQueueStatus = mapQueueStatus(p.status);
            const updates: Record<string, unknown> = {
              provider_status: p.status ?? null,
            };
            if (newQueueStatus) updates.status = newQueueStatus;
            await supabaseAdmin
              .from("call_queue")
              .update(updates as any)
              .eq("id", history.call_queue_id);
          }

          // === Engine sequencial novo ===
          // Avança o progresso do fluxo (SMS condicional + próximo bloco)
          if (p.status && p.status !== "calling") {
            try {
              await handleCallCompletion({
                providerCallId,
                status: p.status,
                durationSeconds: p.duration_seconds ?? 0,
              });
            } catch (e) {
              console.error("[businesscode voice webhook] erro engine:", e);
            }
          }

          // Pós-ação de fluxo (SMS pós-ligação) — só dispara em status finais
          if (
            history.script_id &&
            history.call_queue_id &&
            p.status &&
            p.status !== "calling"
          ) {
            try {
              const { data: flowLink } = await supabaseAdmin
                .from("call_flow_scripts")
                .select("flow_id, call_flows!inner(id, is_active)")
                .eq("script_id", history.script_id)
                .eq("is_active", true)
                .limit(1)
                .maybeSingle();

              const flowId = (flowLink as any)?.flow_id;
              const flowActive = (flowLink as any)?.call_flows?.is_active;

              if (flowId && flowActive) {
                const { data: postAction } = await supabaseAdmin
                  .from("call_flow_post_action")
                  .select("sms_mode, min_listened_seconds")
                  .eq("flow_id", flowId)
                  .maybeSingle();

                if (postAction && postAction.sms_mode && postAction.sms_mode !== "none") {
                  const dur = p.duration_seconds ?? 0;
                  let shouldFire = false;
                  switch (postAction.sms_mode) {
                    case "always":
                      shouldFire = true;
                      break;
                    case "answered":
                      shouldFire =
                        p.status === "answered" ||
                        p.status === "completed" ||
                        p.status === "delivered";
                      break;
                    case "not_answered":
                      shouldFire =
                        p.status === "not_answered" ||
                        p.status === "busy" ||
                        p.status === "failed" ||
                        p.status === "undelivered";
                      break;
                    case "listened_seconds":
                      shouldFire = dur >= (postAction.min_listened_seconds ?? 5);
                      break;
                  }

                  if (shouldFire) {
                    await supabaseAdmin.from("call_flow_executions").insert({
                      flow_id: flowId,
                      lead_id: history.lead_id,
                      script_id: history.script_id,
                      call_queue_id: history.call_queue_id,
                      status: "sms_pending",
                      sms_sent: false,
                      sms_origin: "call_flow",
                    } as any);
                  }
                }
              }
            } catch (e) {
              console.error("[businesscode voice webhook] erro pós-ação fluxo:", e);
            }
          }
        } else {
          console.warn(
            "[businesscode voice webhook] histórico não encontrado para",
            providerCallId,
          );
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      },
    },
  },
});