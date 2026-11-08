import { createFileRoute } from "@tanstack/react-router";
import {
  SHORT_BRASIL_CALLBACK_CORS,
  handleShortBrasilCallback,
} from "@/lib/short-brasil-callback.server";

// Callback Short Brasil das contas da plataforma (URL cadastrada sem token).
// Conta própria da casa: /api/public/sms-webhook/$token. Regras em
// src/lib/short-brasil-callback.server.ts.
export const Route = createFileRoute("/api/public/sms-webhook")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: SHORT_BRASIL_CALLBACK_CORS }),
      GET: async ({ request }) => handleShortBrasilCallback(request),
      POST: async ({ request }) => handleShortBrasilCallback(request),
    },
  },
});
