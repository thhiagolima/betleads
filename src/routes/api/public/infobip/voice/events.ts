import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { handleCallCompletion } from "@/lib/call-flows.server";
import { settleVoiceHistory, voiceCallAnswered } from "@/lib/voice-billing.server";

function authorized(request: Request): boolean {
  const expected = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function valueAt(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const source of [payload, payload.data, payload.properties, payload.call]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of keys) {
      const value = (source as Record<string, unknown>)[key];
      if (value != null) return value;
    }
  }
  return null;
}

function callIdOf(payload: Record<string, unknown>): string | null {
  const value = valueAt(payload, "callId", "call_id", "id");
  return typeof value === "string" && value.trim() ? value : null;
}

function correlationOf(request: Request, payload: Record<string, unknown>): string | null {
  const queryValue = new URL(request.url).searchParams.get("correlation");
  if (queryValue) return queryValue;
  const value = valueAt(payload, "customData", "custom_data", "correlation");
  return typeof value === "string" && value.trim() ? value : null;
}

function durationOf(payload: Record<string, unknown>): number | null {
  const value = valueAt(
    payload,
    "duration",
    "durationSeconds",
    "duration_seconds",
    "callDuration",
    "call_duration_seconds",
  );
  // No duration in the event is null, not 0: an answered call without one is
  // charged the cap (PG3 decision 3), while 0 s counts as unanswered.
  if (value == null || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

function completion(payload: Record<string, unknown>): string | null {
  // Alguns produtos/versões da Infobip devolvem status como string; outros,
  // como objeto { groupName, name, description }. Mantemos ambos legíveis.
  const statusValue = valueAt(payload, "eventType", "event", "type", "status", "state");
  const event = (
    typeof statusValue === "string" ? statusValue : JSON.stringify(statusValue ?? "")
  ).toUpperCase();
  if (event.includes("ESTABLISHED") || event.includes("ANSWERED") || event.includes("CONNECTED"))
    return "answered";
  if (event.includes("BUSY")) return "busy";
  if (event.includes("NO_ANSWER") || event.includes("NOT_ANSWERED") || event.includes("UNANSWERED"))
    return "not_answered";
  if (event.includes("FAILED") || event.includes("REJECTED") || event.includes("ERROR"))
    return "failed";
  if (
    event.includes("FINISHED") ||
    event.includes("COMPLETED") ||
    event.includes("HANGUP") ||
    event.includes("DISCONNECTED") ||
    event.includes("DELIVERED") ||
    event.includes("SUCCESS")
  )
    return "completed";
  return null;
}

function errorOf(payload: Record<string, unknown>): string | null {
  const error = valueAt(payload, "errorDetails", "errorCode", "reason", "cause");
  return typeof error === "string" && error.trim() ? error.slice(0, 1000) : null;
}

/**
 * The journey dispatcher keeps a voice concurrency permit while the call is
 * ongoing (channel_concurrency_permits, see channel-budget.server.ts) and
 * stores its id on call_history. A final event frees it; without this the
 * permit only expires after concurrency_hold_seconds. Idempotent (a repeated
 * final event deletes nothing) and best effort: never fails the callback.
 */
async function releaseVoicePermit(providerResponse: Record<string, unknown>): Promise<void> {
  const permitId = providerResponse.channel_permit_id;
  if (typeof permitId !== "string" || !permitId) return;
  try {
    const { error } = await (
      supabaseAdmin as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      }
    ).rpc("release_channel_slot", { p_permit_id: permitId });
    if (error) console.error("[infobip voice events] release_channel_slot failed", error.message);
  } catch (error) {
    console.error("[infobip voice events] release_channel_slot failed", error);
  }
}

const HISTORY_COLUMNS =
  "id, call_queue_id, provider_call_id, provider_response, tenant_id, status, billing_reference_id, billing_settled_at";

type HistoryRow = {
  id: string;
  call_queue_id: string | null;
  provider_call_id: string | null;
  provider_response: unknown;
  tenant_id?: string | null;
  status?: string | null;
  billing_reference_id?: string | null;
  billing_settled_at?: string | null;
};

export const Route = createFileRoute("/api/public/infobip/voice/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const callId = callIdOf(payload);
        const correlation = correlationOf(request, payload);
        if (!callId && !correlation)
          return Response.json({ ok: true, skipped: "missing_correlation" });
        const result = completion(payload);
        const duration = durationOf(payload);
        let history: HistoryRow | null = null;
        if (callId) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select(HISTORY_COLUMNS)
            .eq("provider_call_id", callId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data as HistoryRow | null;
        }
        if (!history && correlation) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select(HISTORY_COLUMNS)
            .contains("provider_response", { correlation_id: correlation })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data as HistoryRow | null;
        }
        const previous =
          history?.provider_response && typeof history.provider_response === "object"
            ? (history.provider_response as Record<string, unknown>)
            : {};
        const callbacks = Array.isArray(previous.callbacks) ? previous.callbacks : [];
        const callback = { received_at: new Date().toISOString(), payload };
        const update: Record<string, unknown> = {
          provider_response: {
            ...previous,
            callbacks: [...callbacks, callback],
            last_callback: callback,
          },
        };
        if (result) {
          update.status =
            result === "answered" ? "answered" : result === "completed" ? "completed" : "failed";
          update.result = result;
          update.error_message = errorOf(payload);
        }
        if (duration != null) update.duration_seconds = duration;
        const { error: historyUpdateError } = await supabaseAdmin
          .from("call_history")
          .update(update as never)
          .eq("id", history?.id ?? "00000000-0000-0000-0000-000000000000");
        if (historyUpdateError) throw historyUpdateError;
        if (history?.call_queue_id && result) {
          const { error: queueUpdateError } = await supabaseAdmin
            .from("call_queue")
            .update({
              status:
                result === "answered"
                  ? "completed"
                  : result === "completed"
                    ? "completed"
                    : "failed",
              provider_status: result,
            } as never)
            .eq("id", history.call_queue_id);
          if (queueUpdateError) throw queueUpdateError;
        }
        if (result && result !== "answered") {
          // PG3: the final event settles the call's reservation by real use.
          // A repeated final event finds billing_settled_at and does nothing;
          // if two race, the shared key makes the second a replay.
          if (history?.billing_reference_id && history.tenant_id && !history.billing_settled_at) {
            await settleVoiceHistory({
              tenantId: history.tenant_id,
              referenceId: history.billing_reference_id,
              historyId: history.id,
              durationSeconds: duration,
              // The status read BEFORE this event's update: 'answered' means
              // the CML was fetched (cml.ts) or an earlier ANSWERED event came.
              answered: voiceCallAnswered(history),
            });
          }
          await releaseVoicePermit(previous);
          await handleCallCompletion({
            providerCallId: callId ?? history?.provider_call_id ?? correlation ?? "",
            status: result,
            durationSeconds: duration ?? 0,
          });
        }
        return Response.json({
          ok: true,
          call_id: callId,
          correlation,
          matched: Boolean(history),
          status: result,
          duration_seconds: duration,
        });
      },
    },
  },
});
