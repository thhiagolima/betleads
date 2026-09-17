import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type MetaUser = {
  id: string;
  name?: string;
};

type MetaAdAccount = {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  business?: {
    id?: string;
    name?: string;
  };
};

function metaApiVersion() {
  return process.env.META_API_VERSION ?? "v23.0";
}

function metaRedirectUri() {
  return process.env.META_REDIRECT_URI ?? "https://betleads.io/api/meta/oauth/callback";
}

function appBaseUrl() {
  return process.env.VITE_PUBLIC_APP_URL ?? process.env.PUBLIC_APP_URL ?? "https://betleads.io";
}

function requireMetaConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID/META_APP_SECRET nao configurados");
  }
  return { appId, appSecret };
}

function redirectTo(path: string) {
  return Response.redirect(new URL(path, appBaseUrl()), 302);
}

async function fetchMetaJson<T>(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url);
  const json = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `Meta API HTTP ${response.status}`);
  }
  return json as T;
}

async function exchangeCodeForToken(code: string) {
  const { appId, appSecret } = requireMetaConfig();
  const shortToken = await fetchMetaJson<{ access_token: string; expires_in?: number }>(
    "/oauth/access_token",
    {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: metaRedirectUri(),
      code,
    },
  );

  const longToken = await fetchMetaJson<{ access_token: string; expires_in?: number }>(
    "/oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken.access_token,
    },
  );

  return {
    accessToken: longToken.access_token || shortToken.access_token,
    expiresIn: longToken.expires_in ?? shortToken.expires_in ?? null,
  };
}

async function loadAllAdAccounts(accessToken: string) {
  const first = await fetchMetaJson<{ data?: MetaAdAccount[]; paging?: { next?: string } }>(
    "/me/adaccounts",
    {
      access_token: accessToken,
      limit: "200",
      fields: "id,account_id,name,currency,timezone_name,account_status,business{id,name}",
    },
  );

  const rows = [...(first.data ?? [])];
  let next = first.paging?.next;
  while (next) {
    const response = await fetch(next);
    const json = (await response.json().catch(() => ({}))) as {
      data?: MetaAdAccount[];
      paging?: { next?: string };
      error?: { message?: string };
    };
    if (!response.ok || json.error) {
      throw new Error(json.error?.message ?? `Meta API HTTP ${response.status}`);
    }
    rows.push(...(json.data ?? []));
    next = json.paging?.next;
  }
  return rows;
}

export const Route = createFileRoute("/api/meta/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

        if (error) {
          return redirectTo(`/midia-ltv?meta=error&reason=${encodeURIComponent(error)}`);
        }
        if (!code || !state) {
          return redirectTo("/midia-ltv?meta=error&reason=missing_code_or_state");
        }

        try {
          const { data: stateRow, error: stateErr } = await supabaseAdmin
            .from("meta_oauth_states")
            .select("id, tenant_id, user_id, return_to, expires_at, used_at")
            .eq("nonce", state)
            .maybeSingle();

          if (stateErr) throw new Error(stateErr.message);
          if (!stateRow) throw new Error("state invalido");
          if (stateRow.used_at) throw new Error("state ja utilizado");
          if (new Date(String(stateRow.expires_at)).getTime() < Date.now()) {
            throw new Error("state expirado");
          }

          const { accessToken, expiresIn } = await exchangeCodeForToken(code);
          const [metaUser, adAccounts] = await Promise.all([
            fetchMetaJson<MetaUser>("/me", {
              access_token: accessToken,
              fields: "id,name",
            }),
            loadAllAdAccounts(accessToken),
          ]);

          const tokenExpiresAt =
            expiresIn && Number.isFinite(expiresIn)
              ? new Date(Date.now() + expiresIn * 1000).toISOString()
              : null;

          const { data: connection, error: connErr } = await supabaseAdmin
            .from("meta_connections")
            .upsert(
              {
                tenant_id: stateRow.tenant_id,
                connected_by_user_id: stateRow.user_id,
                meta_user_id: metaUser.id,
                meta_user_name: metaUser.name ?? null,
                access_token: accessToken,
                scopes: ["ads_read", "business_management"],
                token_expires_at: tokenExpiresAt,
                status: "connected",
                last_error: null,
                connected_at: new Date().toISOString(),
              },
              { onConflict: "tenant_id,meta_user_id" },
            )
            .select("id")
            .single();
          if (connErr) throw new Error(connErr.message);

          if (adAccounts.length > 0) {
            const { error: accountsErr } = await supabaseAdmin.from("meta_ad_accounts").upsert(
              adAccounts.map((account) => ({
                tenant_id: stateRow.tenant_id,
                connection_id: connection.id,
                meta_ad_account_id: account.id,
                account_id: account.account_id ?? null,
                name: account.name ?? null,
                business_id: account.business?.id ?? null,
                business_name: account.business?.name ?? null,
                currency: account.currency ?? null,
                timezone_name: account.timezone_name ?? null,
                account_status: account.account_status ?? null,
                selected: true,
                raw: account,
              })),
              { onConflict: "tenant_id,meta_ad_account_id" },
            );
            if (accountsErr) throw new Error(accountsErr.message);
          }

          await supabaseAdmin
            .from("meta_oauth_states")
            .update({ used_at: new Date().toISOString() })
            .eq("id", stateRow.id);

          await supabaseAdmin.from("marketing_integrations").upsert(
            {
              tenant_id: stateRow.tenant_id,
              provider: "meta",
              status: "connected",
              account_name: metaUser.name ?? "Meta Ads",
              external_account_id: metaUser.id,
              settings: {
                scopes: ["ads_read", "business_management"],
                ad_accounts: adAccounts.length,
              },
              connected_at: new Date().toISOString(),
            },
            { onConflict: "tenant_id,provider,external_account_id" },
          );

          const returnTo = String(stateRow.return_to ?? "/midia-ltv");
          const separator = returnTo.includes("?") ? "&" : "?";
          return redirectTo(`${returnTo}${separator}meta=connected&accounts=${adAccounts.length}`);
        } catch (e) {
          const message = e instanceof Error ? e.message : "erro_meta_oauth";
          return redirectTo(`/midia-ltv?meta=error&reason=${encodeURIComponent(message)}`);
        }
      },
    },
  },
});
