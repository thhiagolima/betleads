import { createFileRoute } from "@tanstack/react-router";

import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runSmsRouteProbe } from "@/lib/sms-route-probe.server";

// Sonda da rota SMS: pg_cron chama a cada 30 min (ver
// 20261229100100_sms_route_probes_cron.sql). Manda o SMS de controle para os
// números do admin; sem sonda ligada ou sem número não envia nada.

export const Route = createFileRoute("/api/public/hooks/sms-route-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("sms_route_probe", { kind: "probe", channel: "sms" });
        try {
          const result = await runSmsRouteProbe(new Date());
          // A rodada em si deu certo mesmo com SMS recusado (sem saldo é o que
          // ela existe para detectar): a barra do admin avisa, não o job.
          await run.finish({
            status: "succeeded",
            claimed: result.sent,
            sent: result.results.filter((r) => r === "accepted").length,
            stop_reason: result.skipped ?? "ok",
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[sms-route-probe]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
