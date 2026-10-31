// MCP financeiro: the MCP endpoint (Streamable HTTP, stateless, JSON
// responses). 404 when MCP_ENABLED is off; 401 + WWW-Authenticate without a
// valid bearer. See src/lib/mcp/server.server.ts.
import { createFileRoute } from "@tanstack/react-router";

import { handleMcpRequest } from "@/lib/mcp/server.server";

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => handleMcpRequest(request),
      GET: async ({ request }) => handleMcpRequest(request),
      DELETE: async ({ request }) => handleMcpRequest(request),
    },
  },
});
