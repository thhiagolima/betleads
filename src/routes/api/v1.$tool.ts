// API de leitura: POST /api/v1/{ferramenta} and GET /api/v1/openapi.json. See src/lib/api/handler.server.ts.
import { createFileRoute } from "@tanstack/react-router";

import { handleApiRequest } from "@/lib/api/handler.server";

export const Route = createFileRoute("/api/v1/$tool")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handleApiRequest(request, params.tool),
      POST: async ({ request, params }) => handleApiRequest(request, params.tool),
    },
  },
});
