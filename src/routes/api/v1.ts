// API de leitura: GET /api/v1 lists the tools the key may call. See src/lib/api/handler.server.ts.
import { createFileRoute } from "@tanstack/react-router";

import { handleApiRequest } from "@/lib/api/handler.server";

export const Route = createFileRoute("/api/v1")({
  server: {
    handlers: {
      GET: async ({ request }) => handleApiRequest(request, null),
      POST: async ({ request }) => handleApiRequest(request, null),
    },
  },
});
