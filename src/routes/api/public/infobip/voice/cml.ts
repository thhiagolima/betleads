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
        const audio = new URL(request.url).searchParams.get("audio");
        if (!audio || !/^https:\/\//i.test(audio)) {
          return Response.json({ error: "invalid audio" }, { status: 400 });
        }
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
        if (callId) {
          const { data: history } = await supabaseAdmin
            .from("call_history")
            .select("provider_response")
            .eq("provider_call_id", callId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const previous = (history?.provider_response && typeof history.provider_response === "object")
            ? history.provider_response as Record<string, unknown>
            : {};
          const callbacks = Array.isArray(previous.callbacks) ? previous.callbacks : [];
          const callback = { received_at: new Date().toISOString(), type: "cml_answered", payload };
          await supabaseAdmin
            .from("call_history")
            .update({
              status: "answered",
              result: "answered",
              provider_response: { ...previous, callbacks: [...callbacks, callback], last_callback: callback },
            } as never)
            .eq("provider_call_id", callId);
        }
        return Response.json({
          actions: [
            { action: "play", content: { type: "URL", fileUrl: audio } },
            { action: "hangup" },
          ],
        });
      },
    },
  },
});
