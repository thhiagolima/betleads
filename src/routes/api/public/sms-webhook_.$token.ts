import { createFileRoute } from "@tanstack/react-router";
import {
  SHORT_BRASIL_CALLBACK_CORS,
  handleShortBrasilCallback,
} from "@/lib/short-brasil-callback.server";

// Callback Short Brasil de conta própria da casa: o token da conta vai no
// caminho (com ?token= a Short Brasil devolve só o token, sem id nem status).
// Token inválido -> 401. Regras em src/lib/short-brasil-callback.server.ts.
export const Route = createFileRoute("/api/public/sms-webhook_/$token")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: SHORT_BRASIL_CALLBACK_CORS }),
      GET: async ({ request, params }) => handleShortBrasilCallback(request, params.token),
      POST: async ({ request, params }) => handleShortBrasilCallback(request, params.token),
    },
  },
});
