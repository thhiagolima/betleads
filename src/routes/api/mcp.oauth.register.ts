// MCP financeiro: dynamic client registration (RFC 7591). Public clients
// only; redirect URIs must be the Claude callbacks or loopback (Claude Code).
import { createFileRoute } from "@tanstack/react-router";

import { isMcpEnabled } from "@/lib/mcp/config.server";
import {
  notFound,
  oauthErrorResponse,
  oauthJson,
  readRegisterBody,
  registerClient,
} from "@/lib/mcp/oauth.server";

export const Route = createFileRoute("/api/mcp/oauth/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isMcpEnabled()) return notFound();
        try {
          // Body capped at 16 KB (declared and actual) before parsing.
          const body = await readRegisterBody(request);
          return oauthJson(await registerClient(body), 201);
        } catch (error) {
          return oauthErrorResponse(error);
        }
      },
    },
  },
});
