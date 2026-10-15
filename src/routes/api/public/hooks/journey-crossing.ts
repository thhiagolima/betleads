import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { runJourneyCrossing } from "@/lib/journey-crossing.server";

export const Route = createFileRoute("/api/public/hooks/journey-crossing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        try {
          const result = await runJourneyCrossing();
          return Response.json({ ok: true, result });
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
