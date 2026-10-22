import { createFileRoute } from "@tanstack/react-router";

import { runBillingCycle } from "@/lib/billing/invoices.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { withJobRun } from "@/lib/observability/job-monitor.server";

// Hourly billing cycle cron (Task 3). pg_cron hits this every hour (see the
// matching migration). Generates due invoices (flag-gated), refreshes every
// non-exempt house's access state (always) and notifies the e-mail pipeline
// (Task 5, injected later) about what was issued.

export const Route = createFileRoute("/api/public/hooks/billing-cycle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        try {
          const counters = await withJobRun("billing-cycle", {}, async (run) => {
            const result = await runBillingCycle();
            run.progress({
              claimed: result.refreshed,
              sent: result.generated,
              errors: result.errors,
            });
            return result;
          });
          return Response.json({ ok: true, ...counters });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
  },
});
