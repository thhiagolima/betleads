import { createFileRoute } from "@tanstack/react-router";

import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runDailyDigest } from "@/lib/platform-health/daily-digest.server";

// Platform daily-digest cron (console super-admin F3, Task 4). pg_cron hits
// this once a day at 11:00 UTC (= 08:00 BRT): it e-mails every super admin a
// summary of open alerts, red/yellow houses and who owes money. See
// daily-digest.server.ts for the idempotency (one send per Brasília day) and
// the flag that gates e-mail delivery.

export const Route = createFileRoute("/api/public/hooks/platform-digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("platform_digest", { kind: "sync" });
        try {
          const result = await runDailyDigest(new Date());
          await run.finish({ sent: result.recipients });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[platform-digest]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
