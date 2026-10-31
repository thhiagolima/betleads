// MCP financeiro: OAuth metadata (/.well-known/oauth-authorization-server). 404 when MCP_ENABLED is off.
import { createFileRoute } from "@tanstack/react-router";

import { isMcpEnabled } from "@/lib/mcp/config.server";
import { wellKnownResponse } from "@/lib/mcp/oauth.server";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")({
  server: {
    handlers: {
      GET: async ({ request }) => wellKnownResponse(request, isMcpEnabled()),
    },
  },
});
