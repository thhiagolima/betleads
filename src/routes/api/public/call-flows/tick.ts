// Endpoint público chamado por pg_cron a cada minuto para avançar os
// progressos sequenciais de Fluxos de Ligação.
// Auth: header `apikey` com a chave anon do projeto.

import { createFileRoute } from "@tanstack/react-router";
import { tickFlows } from "@/lib/call-flows.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/call-flows/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const result = await tickFlows(100);
          return new Response(JSON.stringify({ ok: true, ...result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[call-flows tick] erro", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});