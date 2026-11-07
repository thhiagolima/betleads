import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ownedAccountIdsFor,
  resolveCallbackScope,
  scopeAllowsRow,
  touchCallbackReceived,
} from "@/lib/provider-callback-tokens.server";

// ?token= is INFOBIP_VOICE_CALLBACK_TOKEN for platform accounts or the
// account's own token for a house-owned account
// (provider-callback-tokens.server.ts). A call outside the token's scope is
// answered with a bare hangup: no update and none of its TTS script.
const OUT_OF_SCOPE_CML = { actions: [{ action: "hangup" }] };

const HISTORY_COLUMNS = "id, call_queue_id, provider_response, provider_account_id";

export const Route = createFileRoute("/api/public/infobip/voice/cml")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const scope = await resolveCallbackScope(
          url.searchParams.get("token"),
          process.env.INFOBIP_VOICE_CALLBACK_TOKEN,
        );
        if (!scope) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (scope.kind === "account") await touchCallbackReceived(scope.accountId);
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
        let history = null;
        if (callId) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select(HISTORY_COLUMNS)
            .eq("provider_call_id", callId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        if (!history && correlation) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select(HISTORY_COLUMNS)
            .contains("provider_response", { correlation_id: correlation })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
        }
        // Without a row nothing is updated (and a TTS call 409s below): the
        // audio comes from this signed URL, as today.
        if (
          history &&
          !scopeAllowsRow(
            scope,
            (history as { provider_account_id?: string | null }).provider_account_id ?? null,
            await ownedAccountIdsFor(scope),
          )
        ) {
          return Response.json(OUT_OF_SCOPE_CML);
        }
        const previous =
          history?.provider_response && typeof history.provider_response === "object"
            ? (history.provider_response as Record<string, unknown>)
            : {};
        const tts = previous.cml as
          { type?: unknown; text?: unknown; language?: unknown } | undefined;
        const ttsText = typeof tts?.text === "string" ? tts.text : null;
        if (isTts && (tts?.type !== "say" || !ttsText?.trim())) {
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
        }
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
