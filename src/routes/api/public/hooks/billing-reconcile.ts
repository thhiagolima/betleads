import { createFileRoute } from "@tanstack/react-router";

import { reconcilePendingCharges } from "@/lib/billing/payment-charges.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { withJobRun } from "@/lib/observability/job-monitor.server";

// Reconciliation cron for Pix charges (Task 5). pg_cron hits this every 5
// minutes (see the matching migration). The webhook
// (src/routes/api/public/upper/webhook.ts) is the fast path; this is the
// safety net for anything that drifted — a webhook that never arrived or
// failed mid-processing, a crediting RPC call that errored right after a
// PAID snapshot, or a PIX QR that quietly expired on Upper's side.

export const Route = createFileRoute("/api/public/hooks/billing-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        try {
          const counters = await withJobRun("billing-reconcile", {}, async (run) => {
            const result = await reconcilePendingCharges();
            run.progress({
              claimed: result.checked,
              sent: result.credited,
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
