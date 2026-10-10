import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { reconcileChannelCallbacks } from "@/lib/infobip-voice-reconciliation.server";

export const Route = createFileRoute("/api/public/infobip/voice/reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (response) { return response as Response; }
        try {
          return Response.json({ ok: true, ...(await reconcileChannelCallbacks()) });
        } catch (error) {
          console.error("[infobip voice reconciliation] failed", error);
          return Response.json({ ok: false, error: "channel reconciliation failed" }, { status: 500 });
        }
      },
    },
  },
});
