import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptMetaToken, encryptMetaToken, metaTokenHint } from "@/lib/meta-token.server";

const DEFAULT_SCOPES = ["ads_read", "business_management"];

const oauthSchema = z.object({
  returnTo: z.string().trim().max(300).optional(),
});

const syncSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
});
const systemTokenSchema = z.object({
  accessToken: z.string().trim().min(40).max(1000),
});
const metaConnectionSchema = z.object({
  connectionId: z.string().uuid(),
});
const metaAccountSelectionSchema = z.object({
  accountIds: z.array(z.string().uuid()).max(200),
});

type MetaInsight = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
};

type MetaAd = {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    effective_status?: string;
  };
  adset?: {
    id?: string;
    name?: string;
    status?: string;
    effective_status?: string;
  };
};

type MetaAccountForSync = {
  id: string;
  tenant_id: string;
  connection_id: string;
  meta_ad_account_id: string;
  account_id: string | null;
  name: string | null;
  currency: string | null;
  meta_connections:
    | {
        access_token: string;
        encrypted_access_token?: string | null;
      }
    | {
        access_token: string;
        encrypted_access_token?: string | null;
      }[]
    | null;
};

type MetaPermission = { permission: string; status: string };
type MetaApp = { id: string; name?: string };

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

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function accountPath(id: string) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

async function fetchMetaJson<T>(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${metaApiVersion()}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("A Meta demorou demais para responder. Tente novamente.");
    }
    throw new Error("Não foi possível acessar a API da Meta.");
  } finally {
    clearTimeout(timeout);
  }
  const json = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
    paging?: { next?: string };
  };
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `Meta API HTTP ${response.status}`);
  }
  return json as T & { paging?: { next?: string } };
}

async function loadInsights(accessToken: string, adAccountId: string, days: number) {
  const until = new Date();
  const since = new Date();
  since.setDate(until.getDate() - (days - 1));

  const fields = [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
  ].join(",");

  const first = await fetchMetaJson<{ data?: MetaInsight[] }>(
    `/${accountPath(adAccountId)}/insights`,
    {
      access_token: accessToken,
      fields,
      level: "ad",
      time_increment: "1",
      limit: "500",
      time_range: JSON.stringify({
        since: dateOnly(since),
        until: dateOnly(until),
      }),
    },
  );

  const rows = [...(first.data ?? [])];
  let next = first.paging?.next;
  while (next) {
    const response = await fetch(next);
    const json = (await response.json().catch(() => ({}))) as {
      data?: MetaInsight[];
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

async function loadActiveAds(accessToken: string, adAccountId: string) {
  const first = await fetchMetaJson<{ data?: MetaAd[] }>(`/${accountPath(adAccountId)}/ads`, {
    access_token: accessToken,
    fields:
      "id,name,status,effective_status,campaign{id,name,status,effective_status},adset{id,name,status,effective_status}",
    effective_status: JSON.stringify(["ACTIVE"]),
    limit: "500",
  });

  const rows = [...(first.data ?? [])];
  let next = first.paging?.next;
  while (next) {
    const response = await fetch(next);
    const json = (await response.json().catch(() => ({}))) as {
      data?: MetaAd[];
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

async function loadAllAdAccounts(accessToken: string) {
  const first = await fetchMetaJson<{ data?: Array<any>; paging?: { next?: string } }>(
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(next, { signal: controller.signal });
      const json = (await response.json()) as {
        data?: Array<any>;
        paging?: { next?: string };
        error?: { message?: string };
      };
      if (!response.ok || json.error) {
        throw new Error(json.error?.message ?? `Meta API HTTP ${response.status}`);
      }
      rows.push(...(json.data ?? []));
      next = json.paging?.next;
    } finally {
      clearTimeout(timeout);
    }
  }
  return rows;
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

export const connectMetaSystemUserToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => systemTokenSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const token = data.accessToken;
    const [metaUser, metaApp, permissions, adAccounts] = await Promise.all([
      fetchMetaJson<MetaUser>("/me", { access_token: token, fields: "id,name" }),
      fetchMetaJson<MetaApp>("/app", { access_token: token, fields: "id,name" }),
      fetchMetaJson<{ data?: MetaPermission[] }>("/me/permissions", { access_token: token }),
      loadAllAdAccounts(token),
    ]);
    const granted = (permissions.data ?? [])
      .filter((item) => item.status === "granted")
      .map((item) => item.permission);
    if (!granted.includes("ads_read")) throw new Error("O token não possui a permissão ads_read.");
    if (adAccounts.length === 0)
      throw new Error("O usuário do sistema não possui contas de anúncios atribuídas.");

    const encrypted = await encryptMetaToken(token);
    const checkedAt = new Date().toISOString();
    const groups = new Map<string, Array<any>>();
    for (const account of adAccounts) {
      const businessKey = account.business?.id ?? "__no_business__";
      groups.set(businessKey, [...(groups.get(businessKey) ?? []), account]);
    }

    const connectionIds: string[] = [];
    for (const [businessKey, businessAccounts] of groups) {
      const business = businessAccounts.find((account) => account.business?.id)?.business ?? null;
      let existingQuery = (supabaseAdmin as any)
        .from("meta_connections")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("auth_type", "system_user_token")
        .eq("app_id", metaApp.id)
        .eq("meta_user_id", metaUser.id)
        .neq("status", "disabled");
      existingQuery =
        businessKey === "__no_business__"
          ? existingQuery.is("business_id", null)
          : existingQuery.eq("business_id", businessKey);
      const { data: existing, error: existingError } = await existingQuery.maybeSingle();
      if (existingError) throw new Error(existingError.message);

      const connectionValues = {
        tenant_id: tenantId,
        connected_by_user_id: context.userId,
        meta_user_id: metaUser.id,
        meta_user_name: metaUser.name ?? "Usuário do sistema Meta",
        access_token: null,
        encrypted_access_token: encrypted,
        token_hint: metaTokenHint(token),
        auth_type: "system_user_token",
        scopes: granted,
        app_id: metaApp.id,
        app_name: metaApp.name ?? null,
        business_id: business?.id ?? null,
        connection_label: business?.name ?? metaApp.name ?? "Conta Meta",
        token_validated_at: checkedAt,
        permissions_checked_at: checkedAt,
        status: "connected",
        disabled_at: null,
        disabled_by_user_id: null,
        last_error: null,
        connected_at: checkedAt,
      };

      const connectionResult = existing?.id
        ? await (supabaseAdmin as any)
            .from("meta_connections")
            .update(connectionValues)
            .eq("id", existing.id)
            .select("id")
            .single()
        : await (supabaseAdmin as any)
            .from("meta_connections")
            .insert(connectionValues)
            .select("id")
            .single();
      if (connectionResult.error) throw new Error(connectionResult.error.message);
      const connectionId = connectionResult.data.id as string;
      connectionIds.push(connectionId);

      const accountIds = businessAccounts.map((account) => account.id);
      const { data: knownAccounts, error: knownAccountsError } = await (supabaseAdmin as any)
        .from("meta_ad_accounts")
        .select("id,meta_ad_account_id,selected")
        .eq("tenant_id", tenantId)
        .eq("connection_id", connectionId);
      if (knownAccountsError) throw new Error(knownAccountsError.message);
      const inaccessibleAccountIds = (knownAccounts ?? [])
        .filter(
          (account: { meta_ad_account_id: string }) =>
            !accountIds.includes(account.meta_ad_account_id),
        )
        .map((account: { id: string }) => account.id);
      if (inaccessibleAccountIds.length > 0) {
        const { error: inaccessibleError } = await (supabaseAdmin as any)
          .from("meta_ad_accounts")
          .update({ selected: false })
          .eq("tenant_id", tenantId)
          .in("id", inaccessibleAccountIds);
        if (inaccessibleError) throw new Error(inaccessibleError.message);
      }
      const selectionByAccount = new Map(
        (knownAccounts ?? []).map((account: { meta_ad_account_id: string; selected: boolean }) => [
          account.meta_ad_account_id,
          account.selected,
        ]),
      );

      const { error: accountsError } = await (supabaseAdmin as any).from("meta_ad_accounts").upsert(
        businessAccounts.map((account) => ({
          tenant_id: tenantId,
          connection_id: connectionId,
          meta_ad_account_id: account.id,
          account_id: account.account_id ?? null,
          name: account.name ?? account.id,
          business_id: account.business?.id ?? null,
          business_name: account.business?.name ?? null,
          currency: account.currency ?? null,
          timezone_name: account.timezone_name ?? null,
          account_status: account.account_status ?? null,
          selected: selectionByAccount.get(account.id) ?? false,
          raw: account,
        })),
        { onConflict: "tenant_id,meta_ad_account_id" },
      );
      if (accountsError) throw new Error(accountsError.message);

      const { error: auditError } = await (supabaseAdmin as any)
        .from("meta_connection_audit")
        .insert([
          {
            tenant_id: tenantId,
            connection_id: connectionId,
            actor_user_id: context.userId,
            action: existing?.id ? "token_replaced" : "connected",
            metadata: { app_id: metaApp.id, business_id: business?.id ?? null },
          },
          {
            tenant_id: tenantId,
            connection_id: connectionId,
            actor_user_id: context.userId,
            action: "accounts_discovered",
            metadata: { count: businessAccounts.length },
          },
        ]);
      if (auditError) throw new Error(auditError.message);

      await (supabaseAdmin as any).from("marketing_integrations").upsert(
        {
          tenant_id: tenantId,
          provider: "meta",
          status: "configured",
          account_name: business?.name ?? metaApp.name ?? "Meta Ads",
          external_account_id: business?.id ?? metaApp.id,
          settings: {
            app_id: metaApp.id,
            connection_id: connectionId,
            discovered_accounts: businessAccounts.length,
            selected_accounts: 0,
          },
          connected_at: checkedAt,
        },
        { onConflict: "tenant_id,provider,external_account_id" },
      );
    }

    return {
      connectionIds,
      userName: metaUser.name ?? null,
      app: { id: metaApp.id, name: metaApp.name ?? null },
      permissions: granted,
      accounts: adAccounts.map((account) => ({
        id: account.id,
        name: account.name ?? account.id,
        businessName: account.business?.name ?? null,
        currency: account.currency ?? null,
        selected: false,
      })),
    };
  });

export const updateMetaAccountSelection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaAccountSelectionSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const { data: accounts, error: accountsError } = await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .select("id,connection_id,meta_connections!inner(status)")
      .eq("tenant_id", tenantId)
      .eq("meta_connections.status", "connected");
    if (accountsError) throw new Error(accountsError.message);

    const knownIds = new Set((accounts ?? []).map((account: { id: string }) => account.id));
    if (data.accountIds.some((id) => !knownIds.has(id))) {
      throw new Error("Uma das contas selecionadas não pertence à sua operação.");
    }

    const { error: clearError } = await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .update({ selected: false })
      .eq("tenant_id", tenantId);
    if (clearError) throw new Error(clearError.message);

    if (data.accountIds.length > 0) {
      const { error: selectError } = await (supabaseAdmin as any)
        .from("meta_ad_accounts")
        .update({ selected: true })
        .eq("tenant_id", tenantId)
        .in("id", data.accountIds);
      if (selectError) throw new Error(selectError.message);
    }

    const connectionIds = [
      ...new Set(
        (accounts ?? []).map((account: { connection_id: string }) => account.connection_id),
      ),
    ];
    if (connectionIds.length > 0) {
      const { error: auditError } = await (supabaseAdmin as any)
        .from("meta_connection_audit")
        .insert(
          connectionIds.map((connectionId) => ({
            tenant_id: tenantId,
            connection_id: connectionId,
            actor_user_id: context.userId,
            action: "accounts_selected",
            metadata: {
              selected_count: (accounts ?? []).filter(
                (account: { id: string; connection_id: string }) =>
                  account.connection_id === connectionId && data.accountIds.includes(account.id),
              ).length,
            },
          })),
        );
      if (auditError) throw new Error(auditError.message);
    }

    return { selected: data.accountIds.length };
  });

export const validateMetaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaConnectionSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const { data: connection, error: connectionError } = await (supabaseAdmin as any)
      .from("meta_connections")
      .select("id,encrypted_access_token,access_token,app_id,business_id,status")
      .eq("tenant_id", tenantId)
      .eq("id", data.connectionId)
      .maybeSingle();
    if (connectionError) throw new Error(connectionError.message);
    if (!connection || connection.status === "disabled")
      throw new Error("Conexão Meta não encontrada.");

    const token = connection.encrypted_access_token
      ? await decryptMetaToken(connection.encrypted_access_token)
      : connection.access_token;
    if (!token) throw new Error("A conexão não possui um token válido.");

    try {
      const [metaApp, permissions, adAccounts] = await Promise.all([
        fetchMetaJson<MetaApp>("/app", { access_token: token, fields: "id,name" }),
        fetchMetaJson<{ data?: MetaPermission[] }>("/me/permissions", { access_token: token }),
        loadAllAdAccounts(token),
      ]);
      const granted = (permissions.data ?? [])
        .filter((item) => item.status === "granted")
        .map((item) => item.permission);
      if (!granted.includes("ads_read")) throw new Error("A permissão ads_read não está ativa.");
      if (connection.app_id && connection.app_id !== metaApp.id) {
        throw new Error("O token foi emitido por outro app Meta.");
      }
      const businessAccounts = connection.business_id
        ? adAccounts.filter((account) => account.business?.id === connection.business_id)
        : adAccounts;
      if (businessAccounts.length === 0) {
        throw new Error("O token não possui mais acesso às contas deste Business Manager.");
      }

      const checkedAt = new Date().toISOString();
      await (supabaseAdmin as any)
        .from("meta_connections")
        .update({
          scopes: granted,
          token_validated_at: checkedAt,
          permissions_checked_at: checkedAt,
          status: "connected",
          last_error: null,
        })
        .eq("id", connection.id);
      await (supabaseAdmin as any).from("meta_connection_audit").insert({
        tenant_id: tenantId,
        connection_id: connection.id,
        actor_user_id: context.userId,
        action: "validated",
        metadata: { accessible_accounts: businessAccounts.length },
      });
      return { ok: true, accounts: businessAccounts.length, permissions: granted };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Não foi possível validar a conexão.";
      await (supabaseAdmin as any)
        .from("meta_connections")
        .update({
          status: "error",
          last_error: message,
          permissions_checked_at: new Date().toISOString(),
        })
        .eq("id", connection.id);
      throw new Error(message);
    }
  });

export const disconnectMetaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => metaConnectionSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const { data: connection, error: connectionError } = await (supabaseAdmin as any)
      .from("meta_connections")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", data.connectionId)
      .neq("status", "disabled")
      .maybeSingle();
    if (connectionError) throw new Error(connectionError.message);
    if (!connection) throw new Error("Conexão Meta não encontrada.");

    const now = new Date().toISOString();
    const { error: accountsError } = await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .update({ selected: false })
      .eq("tenant_id", tenantId)
      .eq("connection_id", connection.id);
    if (accountsError) throw new Error(accountsError.message);

    const { error: updateError } = await (supabaseAdmin as any)
      .from("meta_connections")
      .update({
        status: "disabled",
        encrypted_access_token: null,
        access_token: null,
        disabled_at: now,
        disabled_by_user_id: context.userId,
        last_error: null,
      })
      .eq("id", connection.id);
    if (updateError) throw new Error(updateError.message);

    await (supabaseAdmin as any).from("meta_connection_audit").insert({
      tenant_id: tenantId,
      connection_id: connection.id,
      actor_user_id: context.userId,
      action: "disabled",
      metadata: {},
    });
    return { ok: true };
  });

export const getMetaConnectionSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveTenantId(context.supabase);

    const [connectionsRes, accountsRes] = await Promise.all([
      supabaseAdmin
        .from("meta_connections")
        .select(
          "id, meta_user_id, meta_user_name, scopes, token_expires_at, status, last_error, connected_at, last_sync_at, auth_type, token_hint, token_validated_at, permissions_checked_at, app_id, app_name, business_id, connection_label",
        )
        .eq("tenant_id", tenantId)
        .neq("status", "disabled")
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

async function syncMetaAccount(tenantId: string, account: MetaAccountForSync, days: number) {
  const connection = Array.isArray(account.meta_connections)
    ? account.meta_connections[0]
    : account.meta_connections;
  const token = connection?.encrypted_access_token
    ? await decryptMetaToken(connection.encrypted_access_token)
    : connection?.access_token;
  if (!token) throw new Error("A conexão não possui um token válido.");

  let imported = 0;
  const now = new Date().toISOString();
  const activeAds = await loadActiveAds(token, account.meta_ad_account_id);
  if (activeAds.length > 0) {
    const today = dateOnly(new Date());
    const rows = activeAds.map((ad) => ({
      tenant_id: tenantId,
      provider: "meta",
      ad_account_id: account.meta_ad_account_id,
      campaign_id: ad.campaign?.id ?? null,
      campaign_name: ad.campaign?.name ?? null,
      adset_id: ad.adset?.id ?? null,
      adset_name: ad.adset?.name ?? null,
      ad_id: ad.id,
      ad_name: ad.name ?? ad.id,
      creative_name: ad.name ?? ad.id,
      metric_date: today,
      spend: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      cpc: 0,
      cpm: 0,
      raw: ad,
      imported_at: now,
    }));
    const { error } = await supabaseAdmin
      .from("marketing_ad_metrics_daily")
      .upsert(rows, { onConflict: "tenant_id,provider,metric_date,ad_account_id,ad_id" });
    if (error) throw new Error(error.message);
    imported += rows.length;
  }

  const insights = await loadInsights(token, account.meta_ad_account_id, days);
  if (insights.length > 0) {
    const rows = insights.map((row) => ({
      tenant_id: tenantId,
      provider: "meta",
      ad_account_id: account.meta_ad_account_id,
      campaign_id: row.campaign_id ?? null,
      campaign_name: row.campaign_name ?? null,
      adset_id: row.adset_id ?? null,
      adset_name: row.adset_name ?? null,
      ad_id: row.ad_id ?? null,
      ad_name: row.ad_name ?? null,
      creative_name: row.ad_name ?? null,
      metric_date: row.date_start ?? dateOnly(new Date()),
      spend: toNumber(row.spend),
      impressions: Math.round(toNumber(row.impressions)),
      clicks: Math.round(toNumber(row.clicks)),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
      raw: row,
      imported_at: now,
    }));
    const { error } = await supabaseAdmin
      .from("marketing_ad_metrics_daily")
      .upsert(rows, { onConflict: "tenant_id,provider,metric_date,ad_account_id,ad_id" });
    if (error) throw new Error(error.message);
    imported += rows.length;
  }

  await (supabaseAdmin as any)
    .from("meta_ad_accounts")
    .update({ last_sync_at: now })
    .eq("id", account.id);
  await (supabaseAdmin as any)
    .from("meta_connections")
    .update({ last_sync_at: now, last_error: null, status: "connected" })
    .eq("id", account.connection_id);
  return imported;
}

async function createMetaSyncRun({
  tenantId,
  days,
  triggerType,
  requestedByUserId,
}: {
  tenantId: string;
  days: number;
  triggerType: "manual" | "scheduled" | "backfill";
  requestedByUserId?: string | null;
}) {
  const { data: active } = await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
    .eq("tenant_id", tenantId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) return { ...active, reused: true };

  const { data: accounts, error: accountsError } = await (supabaseAdmin as any)
    .from("meta_ad_accounts")
    .select("id,meta_connections!inner(status)")
    .eq("tenant_id", tenantId)
    .eq("selected", true)
    .eq("meta_connections.status", "connected");
  if (accountsError) throw new Error(accountsError.message);
  if (!accounts?.length) throw new Error("Nenhuma conta Meta selecionada para sincronizar.");

  const { data: run, error: runError } = await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .insert({
      tenant_id: tenantId,
      requested_by_user_id: requestedByUserId ?? null,
      trigger_type: triggerType,
      days,
      total_accounts: accounts.length,
      status: "queued",
    })
    .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
    .single();
  if (runError) {
    if (runError.code === "23505") {
      const { data: concurrent } = await (supabaseAdmin as any)
        .from("meta_sync_runs")
        .select("id,status,total_accounts,processed_accounts,rows_imported,created_at")
        .eq("tenant_id", tenantId)
        .in("status", ["queued", "running"])
        .single();
      if (concurrent) return { ...concurrent, reused: true };
    }
    throw new Error(runError.message);
  }

  const { error: jobsError } = await (supabaseAdmin as any).from("meta_sync_jobs").insert(
    accounts.map((account: { id: string }) => ({
      run_id: run.id,
      tenant_id: tenantId,
      account_id: account.id,
      days,
    })),
  );
  if (jobsError) {
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({
        status: "failed",
        error_summary: jobsError.message,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    throw new Error(jobsError.message);
  }
  return { ...run, reused: false };
}

export const enqueueMetaSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => syncSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    return createMetaSyncRun({
      tenantId,
      days: data.days,
      triggerType: "manual",
      requestedByUserId: context.userId,
    });
  });

export const getMetaSyncRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const { data, error } = await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .select(
        "id,trigger_type,days,status,total_accounts,processed_accounts,successful_accounts,failed_accounts,rows_imported,started_at,finished_at,error_summary,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

function isPermanentMetaError(message: string) {
  return /token|permiss|oauth|ads_read|outro app|não possui mais acesso/i.test(message);
}

async function refreshMetaSyncRun(runId: string) {
  const { data: jobs, error } = await (supabaseAdmin as any)
    .from("meta_sync_jobs")
    .select("status,rows_imported,last_error")
    .eq("run_id", runId);
  if (error) throw new Error(error.message);
  const completed = jobs.filter((job: { status: string }) => job.status === "completed");
  const failed = jobs.filter((job: { status: string }) => job.status === "failed");
  const processed = completed.length + failed.length;
  const pending = jobs.length - processed;
  const status =
    pending > 0
      ? "running"
      : failed.length === 0
        ? "completed"
        : completed.length > 0
          ? "partial"
          : "failed";
  const now = new Date().toISOString();
  await (supabaseAdmin as any)
    .from("meta_sync_runs")
    .update({
      status,
      processed_accounts: processed,
      successful_accounts: completed.length,
      failed_accounts: failed.length,
      rows_imported: jobs.reduce(
        (total: number, job: { rows_imported: number }) => total + (job.rows_imported ?? 0),
        0,
      ),
      finished_at: pending === 0 ? now : null,
      error_summary:
        failed
          .map((job: { last_error?: string | null }) => job.last_error)
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ") || null,
    })
    .eq("id", runId);
}

async function enqueueScheduledMetaSyncs() {
  const { data: accounts } = await (supabaseAdmin as any)
    .from("meta_ad_accounts")
    .select("tenant_id,meta_connections!inner(status)")
    .eq("selected", true)
    .eq("meta_connections.status", "connected");
  const tenantIds = [
    ...new Set((accounts ?? []).map((account: { tenant_id: string }) => account.tenant_id)),
  ];
  const since = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  let enqueued = 0;
  for (const tenantId of tenantIds) {
    const { data: recent } = await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .select("id")
      .eq("tenant_id", tenantId)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) continue;
    try {
      const run = await createMetaSyncRun({ tenantId, days: 7, triggerType: "scheduled" });
      if (!run.reused) enqueued += 1;
    } catch {
      // Uma operação sem contas elegíveis não deve bloquear as demais.
    }
  }
  return enqueued;
}

export async function processMetaSyncQueue(limit = 2) {
  const scheduled = await enqueueScheduledMetaSyncs();
  const workerId = `meta-${crypto.randomUUID()}`;
  const { data: claimed, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_meta_sync_jobs",
    { p_limit: Math.max(1, Math.min(limit, 10)), p_worker_id: workerId },
  );
  if (claimError) throw new Error(claimError.message);

  const claimedRunIds = [...new Set((claimed ?? []).map((job: { run_id: string }) => job.run_id))];
  for (const runId of claimedRunIds) {
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({ status: "running" })
      .eq("id", runId);
    await (supabaseAdmin as any)
      .from("meta_sync_runs")
      .update({ started_at: new Date().toISOString() })
      .eq("id", runId)
      .is("started_at", null);
  }

  let completed = 0;
  let retried = 0;
  let failed = 0;
  for (const job of claimed ?? []) {
    const { data: account, error: accountError } = await (supabaseAdmin as any)
      .from("meta_ad_accounts")
      .select(
        "id,tenant_id,connection_id,meta_ad_account_id,account_id,name,currency,selected,meta_connections!inner(access_token,encrypted_access_token,status)",
      )
      .eq("id", job.account_id)
      .eq("tenant_id", job.tenant_id)
      .eq("selected", true)
      .eq("meta_connections.status", "connected")
      .maybeSingle();
    try {
      if (accountError) throw new Error(accountError.message);
      if (!account) throw new Error("A conta foi removida ou deixou de estar selecionada.");
      await (supabaseAdmin as any).from("meta_connection_audit").insert({
        tenant_id: job.tenant_id,
        connection_id: account.connection_id,
        actor_user_id: null,
        action: "sync_started",
        metadata: { run_id: job.run_id, account_id: job.account_id, attempt: job.attempt_count },
      });
      const imported = await syncMetaAccount(
        job.tenant_id,
        account as MetaAccountForSync,
        job.days,
      );
      await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({
          status: "completed",
          rows_imported: imported,
          finished_at: new Date().toISOString(),
          locked_at: null,
        })
        .eq("id", job.id)
        .eq("worker_id", workerId);
      await (supabaseAdmin as any).from("meta_connection_audit").insert({
        tenant_id: job.tenant_id,
        connection_id: account.connection_id,
        actor_user_id: null,
        action: "sync_succeeded",
        metadata: { run_id: job.run_id, account_id: job.account_id, rows_imported: imported },
      });
      completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro desconhecido ao sincronizar.";
      const canRetry = job.attempt_count < job.max_attempts && !isPermanentMetaError(message);
      const retryAt = new Date(Date.now() + Math.pow(2, job.attempt_count) * 60_000).toISOString();
      await (supabaseAdmin as any)
        .from("meta_sync_jobs")
        .update({
          status: canRetry ? "retry" : "failed",
          next_attempt_at: canRetry ? retryAt : job.next_attempt_at,
          last_error: message.slice(0, 1000),
          finished_at: canRetry ? null : new Date().toISOString(),
          locked_at: null,
        })
        .eq("id", job.id)
        .eq("worker_id", workerId);
      await (supabaseAdmin as any)
        .from("meta_connections")
        .update({
          last_error: message,
          status: isPermanentMetaError(message) ? "error" : "connected",
        })
        .eq("id", account?.connection_id ?? "00000000-0000-0000-0000-000000000000");
      if (account?.connection_id) {
        await (supabaseAdmin as any).from("meta_connection_audit").insert({
          tenant_id: job.tenant_id,
          connection_id: account.connection_id,
          actor_user_id: null,
          action: "sync_failed",
          metadata: {
            run_id: job.run_id,
            account_id: job.account_id,
            retry_scheduled: canRetry,
            attempt: job.attempt_count,
          },
        });
      }
      if (canRetry) retried += 1;
      else failed += 1;
    }
    await refreshMetaSyncRun(job.run_id);
  }
  return { workerId, scheduled, claimed: claimed?.length ?? 0, completed, retried, failed };
}
