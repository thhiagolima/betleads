import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runPopupHourly } from "@/lib/popups/audience.server";
import type { PopupsDb } from "@/lib/popups/popups.server";

// Popups nas casas. pg_cron hits this every hour (see
// 20261230100100_site_popups_cron.sql): closes popups past their end date and
// re-resolves the "filtro do CRM" audience of active/paused popups. See
// audience.server.ts.

export const Route = createFileRoute("/api/public/hooks/popups-hourly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("popups_hourly", { channel: "popup", kind: "tick" });
        try {
          const result = await runPopupHourly(supabaseAdmin as unknown as PopupsDb, { now: new Date() });
          await run.finish({
            claimed: result.refreshed + result.errors.length,
            sent: result.refreshed,
            errors: result.errors.length,
            stop_reason: result.truncated ? "time_budget" : null,
            last_provider_error: result.errors[0]?.message ?? null,
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[popups-hourly]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
