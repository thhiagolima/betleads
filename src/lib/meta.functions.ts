import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_SCOPES = ["ads_read", "business_management"];

const oauthSchema = z.object({
  returnTo: z.string().trim().max(300).optional(),
});

function metaApiVersion() {
  return process.env.META_API_VERSION ?? "v23.0";
}

function metaRedirectUri() {
  return process.env.META_REDIRECT_URI ?? "https://betleads.io/api/meta/oauth/callback";
}

function requireMetaAppId() {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new Error("META_APP_ID nao configurado");
  return appId;
}

function randomNonce() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function resolveTenantId(supabase: {
  rpc: (name: string) => Promise<{ data: unknown; error: { message: string } | null }>;
}) {
  const { data, error } = await supabase.rpc("current_tenant_id");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Tenant nao identificado");
  return data as string;
}

export const createMetaOAuthUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => oauthSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const nonce = randomNonce();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

    const { error } = await supabaseAdmin.from("meta_oauth_states").insert({
      tenant_id: tenantId,
      user_id: context.userId,
      nonce,
      return_to: data.returnTo ?? "/midia-ltv",
      expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);

    const params = new URLSearchParams({
      client_id: requireMetaAppId(),
      redirect_uri: metaRedirectUri(),
      state: nonce,
      response_type: "code",
      scope: DEFAULT_SCOPES.join(","),
    });

    return {
      url: `https://www.facebook.com/${metaApiVersion()}/dialog/oauth?${params.toString()}`,
      expiresAt,
    };
  });

export const getMetaConnectionSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveTenantId(context.supabase);

    const [connectionsRes, accountsRes] = await Promise.all([
      supabaseAdmin
        .from("meta_connections")
        .select(
          "id, meta_user_id, meta_user_name, scopes, token_expires_at, status, last_error, connected_at, last_sync_at",
        )
        .eq("tenant_id", tenantId)
        .order("connected_at", { ascending: false }),
      supabaseAdmin
        .from("meta_ad_accounts")
        .select(
          "id, connection_id, meta_ad_account_id, account_id, name, business_id, business_name, currency, timezone_name, account_status, selected, last_sync_at",
        )
        .eq("tenant_id", tenantId)
        .order("name", { ascending: true }),
    ]);

    if (connectionsRes.error) throw new Error(connectionsRes.error.message);
    if (accountsRes.error) throw new Error(accountsRes.error.message);

    return {
      connections: connectionsRes.data ?? [],
      accounts: accountsRes.data ?? [],
    };
  });
