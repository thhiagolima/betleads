import { createFileRoute } from "@tanstack/react-router";

import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runSmsBalanceCheck } from "@/lib/sms-balance.server";

// Saldo da Short Brasil: pg_cron chama a cada 15 min (ver
// 20261231101900_sms_balance_monitor_cron.sql). Entra no painel e grava o
// saldo; sem login configurado só registra o erro.

export const Route = createFileRoute("/api/public/hooks/sms-balance-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("sms_balance_check", { kind: "probe", channel: "sms" });
        try {
          const read = await runSmsBalanceCheck(new Date());
          // Painel fora ou saldo baixo é o que a barra avisa, não o job.
          await run.finish({
            status: "succeeded",
            claimed: 1,
            sent: read.result === "ok" ? 1 : 0,
            stop_reason: read.result,
          });
          return Response.json({ ok: true, result: read.result, shortcodeSms: read.shortcodeSms });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[sms-balance-check]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
