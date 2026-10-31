// MCP financeiro: dynamic client registration (RFC 7591). Public clients
// only; redirect URIs must be the Claude callbacks or loopback (Claude Code).
import { createFileRoute } from "@tanstack/react-router";

import { isMcpEnabled } from "@/lib/mcp/config.server";
import {
  OAuthError,
  notFound,
  oauthErrorResponse,
  oauthJson,
  registerClient,
} from "@/lib/mcp/oauth.server";

export const Route = createFileRoute("/api/mcp/oauth/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isMcpEnabled()) return notFound();
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return oauthErrorResponse(new OAuthError("invalid_client_metadata", "JSON inválido."));
        }
        try {
          return oauthJson(await registerClient(body), 201);
        } catch (error) {
          return oauthErrorResponse(error);
        }
      },
    },
  },
});
