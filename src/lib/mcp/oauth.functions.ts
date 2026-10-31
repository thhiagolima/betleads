// MCP financeiro: server functions behind the consent screen (/mcp/autorizar).
// The Supabase session lives in browser storage, so the screen is a client
// route and these fns receive the user's Bearer via requireSupabaseAuth.
import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isMcpEnabled } from "@/lib/mcp/config.server";
import { approveMcpAuthorizationFor, getMcpAuthorizationInfoFor } from "@/lib/mcp/oauth.server";

const MCP_OFF = "Conexão com o Claude indisponível.";

// No auth: only tells the consent route whether to exist (flag is server-only).
export const getMcpEnabled = createServerFn({ method: "GET" }).handler(async () => ({
  enabled: isMcpEnabled(),
}));

// Gate for the consent route's beforeLoad. On the server (SSR) it reads the
// flag directly: calling a server fn there would run the global client auth
// middleware, which needs `window`. In the browser it asks getMcpEnabled.
export const mcpConsentEnabled = createIsomorphicFn()
  .server(async () => isMcpEnabled())
  .client(async () => (await getMcpEnabled()).enabled);

const infoInput = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().min(1).max(2048),
});

const approveInput = infoInput.extend({
  codeChallenge: z.string().min(1).max(200),
  codeChallengeMethod: z.string().min(1).max(20),
  state: z.string().max(2048).optional(),
});

export const getMcpAuthorizationInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => infoInput.parse(data))
  .handler(async ({ data, context }) => {
    if (!isMcpEnabled()) throw new Error(MCP_OFF);
    return getMcpAuthorizationInfoFor({ userId: context.userId }, data);
  });

export const approveMcpAuthorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => approveInput.parse(data))
  .handler(async ({ data, context }) => {
    if (!isMcpEnabled()) throw new Error(MCP_OFF);
    return approveMcpAuthorizationFor({ userId: context.userId }, data);
  });
