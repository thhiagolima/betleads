import { createFileRoute } from "@tanstack/react-router";

import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { syncPlatformAlerts } from "@/lib/platform-health/alert-store.server";

// Platform alerts cron (console super-admin F3). pg_cron hits this on a
// schedule (see 20261212100100_platform_alerts_cron.sql): it stores the
// "Saúde" alerts in platform_alerts (open/seen/resolve), e-mails the due
// critical ones to the super admins (only with PLATFORM_ALERTS_EMAIL_ENABLED)
// and purges old history. See alert-store.server.ts.

export const Route = createFileRoute("/api/public/hooks/platform-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("platform_alerts", { kind: "sync" });
        try {
          const result = await syncPlatformAlerts(new Date());
          await run.finish({
            claimed: result.opened + result.seen,
            sent: result.notified,
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[platform-alerts]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
