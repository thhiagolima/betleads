import { createFileRoute } from "@tanstack/react-router";
import { refreshSmsDeliveryStatusInternal } from "@/lib/sms.functions";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/sms-refresh-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const result = await refreshSmsDeliveryStatusInternal();
          return Response.json({ ok: true, ...result });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});