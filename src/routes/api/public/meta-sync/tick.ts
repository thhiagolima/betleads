import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { processMetaSyncQueue } from "@/lib/meta.functions";

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
          const result = await processMetaSyncQueue(2);
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha no worker Meta.";
          console.error("[meta-sync tick]", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
