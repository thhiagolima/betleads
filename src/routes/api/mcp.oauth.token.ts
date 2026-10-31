// MCP financeiro: OAuth token endpoint (authorization_code with PKCE S256,
// refresh_token with rotation). Body is application/x-www-form-urlencoded.
import { createFileRoute } from "@tanstack/react-router";

import { isMcpEnabled } from "@/lib/mcp/config.server";
import {
  OAuthError,
  exchangeToken,
  notFound,
  oauthErrorResponse,
  oauthJson,
} from "@/lib/mcp/oauth.server";

export const Route = createFileRoute("/api/mcp/oauth/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isMcpEnabled()) return notFound();
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
          return oauthErrorResponse(
            new OAuthError("invalid_request", "Use application/x-www-form-urlencoded."),
          );
        }
        try {
          const form = new URLSearchParams(await request.text());
          return oauthJson(await exchangeToken(form));
        } catch (error) {
          return oauthErrorResponse(error);
        }
      },
    },
  },
});
