import { createFileRoute } from "@tanstack/react-router";

import { sendPendingBillingEmails } from "@/lib/billing/billing-emails.server";
import { purgeOldWebhookBodies } from "@/lib/billing/billing-retention.server";
import { runBillingCycle } from "@/lib/billing/invoices.server";
import { sendLowBalanceAlerts } from "@/lib/billing/wallet-alerts.server";
import { settleStaleVoiceReservations } from "@/lib/infobip-voice-reconciliation.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { withJobRun } from "@/lib/observability/job-monitor.server";

// Hourly billing cycle cron (Task 3). pg_cron hits this every hour (see the
// matching migration). Generates due invoices (flag-gated), refreshes every
// non-exempt house's access state (always) and sends every pending billing
// e-mail (Task 5): `sendPendingBillingEmails` itself re-derives what is due
// from the DB (issued/due_today/locked/paid), so it is not limited to the
// invoices this very run generated. It also runs the hourly low-balance
// e-mail sweep (PG3 Task 8, `sendLowBalanceAlerts`) and releases stale voice
// holds (PG3 final fix I2, `settleStaleVoiceReservations`).
//
// After the run is closed (success or failure), an isolated stage nulls the
// raw body/headers of Upper webhook events older than 90 days (scope §8,
// `purgeOldWebhookBodies`). It never changes this response.

async function retentionStage(): Promise<number | null> {
  try {
    const result = await purgeOldWebhookBodies();
    return result.ok ? result.purged : null;
  } catch (error) {
    console.error("[billing-cycle] retention stage failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const Route = createFileRoute("/api/public/hooks/billing-cycle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        let counters: Awaited<ReturnType<typeof runBillingCycle>>;
        try {
          counters = await withJobRun("billing-cycle", {}, async (run) => {
            const result = await runBillingCycle({
              sendEmails: () => sendPendingBillingEmails(),
              sendWalletAlerts: () => sendLowBalanceAlerts(),
              settleVoiceReservations: () => settleStaleVoiceReservations(),
            });
            run.progress({
              claimed: result.refreshed,
              sent: result.generated,
              errors: result.errors,
            });
            return result;
          });
        } catch (error) {
          await retentionStage();
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
        const purged = await retentionStage();
        return Response.json({ ok: true, ...counters, webhook_bodies_purged: purged });
      },
    },
  },
});
