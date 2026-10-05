import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { handleCallCompletion } from "@/lib/call-flows.server";

function authorized(request: Request): boolean {
  const expected = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function completion(payload: Record<string, unknown>): string | null {
  const event = String(payload.eventType ?? payload.event ?? payload.status ?? "").toUpperCase();
  if (event.includes("FINISHED")) return "completed";
  if (event.includes("BUSY")) return "busy";
  if (event.includes("NO_ANSWER")) return "not_answered";
  if (event.includes("FAILED")) return "failed";
  return null;
}

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
        const callId = typeof payload.callId === "string" ? payload.callId : null;
        if (!callId) return Response.json({ ok: true, skipped: "missing_call_id" });
        const result = completion(payload);
        await supabaseAdmin
          .from("call_history")
          .update({
            provider_response: payload as never,
            status: result ? (result === "completed" ? "completed" : "failed") : "pending",
          } as never)
          .eq("provider_call_id", callId);
        if (result) await handleCallCompletion({ providerCallId: callId, status: result });
        return Response.json({ ok: true });
      },
    },
  },
});
