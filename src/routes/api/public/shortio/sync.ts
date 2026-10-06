import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { syncShortioMetrics } from "@/lib/shortio.server";

export const Route = createFileRoute("/api/public/shortio/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        try {
          return Response.json({ ok: true, ...(await syncShortioMetrics(100)) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao sincronizar Short.io.";
          console.error("[shortio sync]", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
