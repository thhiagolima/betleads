import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function authorized(request: Request): boolean {
  const expected = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
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
        if (isTts && !correlation) return Response.json({ error: "missing correlation" }, { status: 400 });
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
        let history = null;
        if (callId) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select("id, provider_response")
            .eq("provider_call_id", callId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        if (!history && correlation) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select("id, provider_response")
            .contains("provider_response", { correlation_id: correlation })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        const previous = (history?.provider_response && typeof history.provider_response === "object")
          ? history.provider_response as Record<string, unknown>
          : {};
        const tts = previous.cml as { type?: unknown; text?: unknown; language?: unknown } | undefined;
        const ttsText = typeof tts?.text === "string" ? tts.text : null;
        if (isTts && (tts?.type !== "say" || !ttsText?.trim())) {
          return Response.json({ error: "tts content not found" }, { status: 409 });
        }
        if (history) {
          const callbacks = Array.isArray(previous.callbacks) ? previous.callbacks : [];
          const callback = { received_at: new Date().toISOString(), type: "cml_answered", payload };
          await supabaseAdmin
            .from("call_history")
            .update({
              status: "answered",
              result: "answered",
              provider_response: { ...previous, callbacks: [...callbacks, callback], last_callback: callback },
            } as never)
            .eq("id", history.id)
            .eq("status", "pending");
        }
        return Response.json({
          actions: [
            isTts
              ? { action: "say", text: ttsText!, language: typeof tts?.language === "string" ? tts.language : "pt" }
              : { action: "play", content: { type: "URL", fileUrl: audio } },
            { action: "hangup" },
          ],
        });
      },
    },
  },
});
