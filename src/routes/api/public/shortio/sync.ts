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
          // Fresh links must be observed quickly. Concurrency remains bounded
          // inside the worker, while this larger batch prevents a campaign
          // backlog from taking hours to reach the reporting pipeline.
          const configuredLimit = Number(process.env.SHORTIO_SYNC_BATCH_SIZE ?? 200);
          const limit = Math.max(
            10,
            Math.min(Number.isFinite(configuredLimit) ? configuredLimit : 200, 500),
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
