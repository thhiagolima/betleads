import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_SCOPES = ["ads_read", "business_management"];

const oauthSchema = z.object({
  returnTo: z.string().trim().max(300).optional(),
});

const syncSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
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
      }
    | {
        access_token: string;
      }[]
    | null;
};

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
  const response = await fetch(url);
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

export const syncMetaInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => syncSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);

    const { data: accounts, error: accountsErr } = await supabaseAdmin
      .from("meta_ad_accounts")
      .select(
        "id, tenant_id, connection_id, meta_ad_account_id, account_id, name, currency, meta_connections!inner(access_token)",
      )
      .eq("tenant_id", tenantId)
      .eq("selected", true);
    if (accountsErr) throw new Error(accountsErr.message);

    const selected = ((accounts ?? []) as unknown as MetaAccountForSync[]).filter(
      (account) => account.meta_ad_account_id,
    );
    if (selected.length === 0) {
      throw new Error("Nenhuma conta Meta selecionada para sincronizar");
    }

    let imported = 0;
    const errors: Array<{ account: string; error: string }> = [];
    const now = new Date().toISOString();

    for (const account of selected) {
      const connection = Array.isArray(account.meta_connections)
        ? account.meta_connections[0]
        : account.meta_connections;
      const token = connection?.access_token;
      if (!token) {
        errors.push({
          account: account.name ?? account.meta_ad_account_id,
          error: "token ausente",
        });
        continue;
      }

      try {
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

          const { error: adsUpsertErr } = await supabaseAdmin
            .from("marketing_ad_metrics_daily")
            .upsert(rows, { onConflict: "tenant_id,provider,metric_date,ad_account_id,ad_id" });
          if (adsUpsertErr) throw new Error(adsUpsertErr.message);
          imported += rows.length;
        }

        const insights = await loadInsights(token, account.meta_ad_account_id, data.days);
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

          const { error: upsertErr } = await supabaseAdmin
            .from("marketing_ad_metrics_daily")
            .upsert(rows, { onConflict: "tenant_id,provider,metric_date,ad_account_id,ad_id" });
          if (upsertErr) throw new Error(upsertErr.message);
          imported += rows.length;
        }

        await supabaseAdmin
          .from("meta_ad_accounts")
          .update({ last_sync_at: now })
          .eq("id", account.id);
        await supabaseAdmin
          .from("meta_connections")
          .update({ last_sync_at: now, last_error: null, status: "connected" })
          .eq("id", account.connection_id);
      } catch (e) {
        const message = e instanceof Error ? e.message : "erro ao sincronizar";
        errors.push({ account: account.name ?? account.meta_ad_account_id, error: message });
        await supabaseAdmin
          .from("meta_connections")
          .update({ last_error: message, status: "error" })
          .eq("id", account.connection_id);
      }
    }

    return {
      ok: errors.length === 0,
      accounts: selected.length,
      imported,
      errors,
    };
  });
