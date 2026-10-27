import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { syncShortioMetrics } from "@/lib/shortio.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";

export const Route = createFileRoute("/api/public/shortio/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("shortio_sync", { channel: "shortio", kind: "sync" });
        try {
          // Links read from Short.io per tick across every house (split
          // between them inside the worker). Concurrency is one shared gate,
          // so a larger batch makes the tick longer, not the request rate
          // higher.
          const configuredLimit = Number(process.env.SHORTIO_SYNC_BATCH_SIZE ?? 600);
          const limit = Math.max(
            10,
            Math.min(Number.isFinite(configuredLimit) ? configuredLimit : 600, 2000),
          );
          const result = await syncShortioMetrics(limit);
          await run.finish({
            claimed: result.total,
            sent: result.processed,
            errors: result.failures,
            stop_reason: result.skipped ? "skipped_active_run" : null,
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao sincronizar Short.io.";
          console.error("[shortio sync]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
