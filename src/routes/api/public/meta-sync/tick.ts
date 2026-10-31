import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { processMetaSyncQueue } from "@/lib/meta.functions";
import { runMetaHealthStage } from "@/lib/meta-health.server";

export const Route = createFileRoute("/api/public/meta-sync/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }

        try {
          const result = await processMetaSyncQueue(6);
          // MB4-02: alertas e heartbeat. Nunca derruba o tick.
          let health: Awaited<ReturnType<typeof runMetaHealthStage>> | null = null;
          try {
            health = await runMetaHealthStage(new Date());
          } catch (error) {
            console.error(
              "[meta-sync tick] health stage",
              error instanceof Error ? error.message : String(error),
            );
          }
          return Response.json({ ok: true, ...result, health });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha no worker Meta.";
          console.error("[meta-sync tick]", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
