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
          // Fresh links must be observed quickly. Concurrency remains bounded
          // inside the worker, while this larger batch prevents a campaign
          // backlog from taking hours to reach the reporting pipeline.
          const configuredLimit = Number(process.env.SHORTIO_SYNC_BATCH_SIZE ?? 200);
          const limit = Math.max(
            10,
            Math.min(Number.isFinite(configuredLimit) ? configuredLimit : 200, 500),
          );
          return Response.json({ ok: true, ...(await syncShortioMetrics(limit)) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao sincronizar Short.io.";
          console.error("[shortio sync]", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
