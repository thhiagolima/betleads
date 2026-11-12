import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function authorized(request: Request): boolean {
  const expected = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

/**
 * Who answered, from the SYNC machine-detection result Infobip sends to the
 * CML callback (`machineDetectionResult`: HUMAN, MACHINE, MACHINE_EOM_BEEP,
 * MACHINE_EOM_SILENCE, MACHINE_EOM_TIMEOUT). Absent or unknown is null, and
 * the message is played: a human call is never dropped on a doubtful signal.
 */
export function answeredByOf(payload: Record<string, unknown>): "human" | "machine" | null {
  const value = payload.machineDetectionResult;
  if (typeof value !== "string") return null;
  const result = value.trim().toUpperCase();
  if (result === "HUMAN") return "human";
  if (result === "MACHINE" || result.startsWith("MACHINE_")) return "machine";
  return null;
}

export const Route = createFileRoute("/api/public/infobip/voice/cml")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const url = new URL(request.url);
        const audio = url.searchParams.get("audio");
        const isTts = url.searchParams.get("mode") === "say";
        const correlation = url.searchParams.get("correlation");
        if (!isTts && (!audio || !/^https:\/\//i.test(audio)))
          return Response.json({ error: "invalid audio" }, { status: 400 });
        if (isTts && !correlation)
          return Response.json({ error: "missing correlation" }, { status: 400 });
        // A Infobip chama o callback CML somente depois de a ligação ser atendida.
        // Marcar aqui evita que a UI permaneça como "em processamento" enquanto
        // aguarda o resumo final enviado ao notifyUrl.
        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.clone().json()) as Record<string, unknown>;
        } catch {
          // O CML continua válido mesmo se o provedor não enviar um corpo JSON.
        }
        const callId = typeof payload.callId === "string" ? payload.callId : null;
        const answeredBy = answeredByOf(payload);
        let history = null;
        if (callId) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select("id, call_queue_id, provider_response")
            .eq("provider_call_id", callId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        if (!history && correlation) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select("id, call_queue_id, provider_response")
            .contains("provider_response", { correlation_id: correlation })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        const previous =
          history?.provider_response && typeof history.provider_response === "object"
            ? (history.provider_response as Record<string, unknown>)
            : {};
        const tts = previous.cml as
          { type?: unknown; text?: unknown; language?: unknown } | undefined;
        const ttsText = typeof tts?.text === "string" ? tts.text : null;
        // A machine is hung up without playing anything, so it needs no content.
        if (answeredBy !== "machine" && isTts && (tts?.type !== "say" || !ttsText?.trim())) {
          return Response.json({ error: "tts content not found" }, { status: 409 });
        }
        if (history) {
          const callbacks = Array.isArray(previous.callbacks) ? previous.callbacks : [];
          const callback = { received_at: new Date().toISOString(), type: "cml_answered", payload };
          const { error: historyUpdateError } = await supabaseAdmin
            .from("call_history")
            .update({
              status: "answered",
              result: "answered",
              provider_response: {
                ...previous,
                callbacks: [...callbacks, callback],
                last_callback: callback,
              },
            } as never)
            .eq("id", history.id)
            .eq("status", "pending");
          if (historyUpdateError) throw historyUpdateError;

          // A busca do CML acontece somente depois que o destinatário atende.
          // Isso já é um resultado terminal para campanhas avulsas, mesmo que a
          // Infobip não entregue depois o resumo opcional do notifyUrl.
          if (history.call_queue_id) {
            const { error: queueUpdateError } = await supabaseAdmin
              .from("call_queue")
              .update({ status: "completed", provider_status: "answered" } as never)
              .eq("id", history.call_queue_id)
              .in("status", ["waiting_provider", "calling"]);
            if (queueUpdateError) throw queueUpdateError;
          }

          // Separate from the status update above: it is recorded even when
          // that one matched no pending row, and a failure here (e.g. the
          // column not migrated yet) must never keep the call from playing.
          if (answeredBy) {
            const { error: answeredByError } = await supabaseAdmin
              .from("call_history")
              .update({ answered_by: answeredBy } as never)
              .eq("id", history.id);
            if (answeredByError)
              console.error("[infobip voice cml] answered_by update failed", answeredByError.message);
          }
        }
        // Answering machine / voicemail: hang up instead of playing. The call
        // was answered, so it settles like any other on the final event.
        if (answeredBy === "machine") return Response.json({ actions: [{ action: "hangup" }] });
        return Response.json({
          actions: [
            isTts
              ? {
                  action: "say",
                  text: ttsText!,
                  language: typeof tts?.language === "string" ? tts.language : "pt",
                }
              : { action: "play", content: { type: "URL", fileUrl: audio } },
            { action: "hangup" },
          ],
        });
      },
    },
  },
});
