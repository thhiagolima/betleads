import { createFileRoute } from "@tanstack/react-router";

import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runWebpushLeadBilling } from "@/lib/webpush/lead-billing.server";

// Web push billing per lead. pg_cron hits this every hour (see
// 20261222100000_webpush_lead_billing_cron.sql): charges each house once per
// new push subscription (item `webpush_lead`), one transaction per house per
// batch. A house without balance stays pending for the next run. See
// lead-billing.server.ts.

export const Route = createFileRoute("/api/public/hooks/webpush-lead-billing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("webpush_lead_billing", {
          channel: "webpush",
          kind: "billing",
        });
        try {
          const result = await runWebpushLeadBilling();
          await run.finish({
            claimed: result.tenants,
            sent: result.billedUnits,
            errors: result.errors.length,
            rate_limited: result.insufficientBalance.length,
            stop_reason: result.truncated ? "time_budget" : null,
            last_provider_error: result.errors[0]?.message ?? null,
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[webpush-lead-billing]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
