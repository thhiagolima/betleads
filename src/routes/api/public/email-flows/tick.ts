// Cron endpoint: roda o dispatcher dos fluxos de email a cada minuto.
import { createFileRoute } from "@tanstack/react-router";
import { runEmailFlowDispatcher } from "@/lib/email-automations.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/email-flows/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const result = await runEmailFlowDispatcher({ limit: 30 });
          return new Response(JSON.stringify({ ok: true, ...result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[email-flows tick] erro", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});