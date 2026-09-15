import { createFileRoute } from "@tanstack/react-router";
import { runDispatcher } from "@/lib/automation.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/automations/dispatch")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const result = await runDispatcher({ limit: 30 });
          return Response.json({ ok: true, ...result });
        } catch (err: any) {
          return Response.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
        }
      },
      GET: async () => Response.json({ ok: true, hint: "POST to run dispatcher" }),
    },
  },
});