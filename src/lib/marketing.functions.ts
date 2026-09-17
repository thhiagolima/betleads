import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const overviewSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
});

const saveIntegrationSchema = z.object({
  provider: z.enum(["meta", "windsor", "csv"]),
  status: z.enum(["planned", "configured", "connected", "error", "disabled"]).default("configured"),
  account_name: z.string().trim().max(120).optional().nullable(),
  external_account_id: z.string().trim().max(120).optional().nullable(),
  currency: z.string().trim().length(3).default("BRL"),
  settings: z.record(z.string(), z.unknown()).default({}),
});

type Integration = {
  id: string;
  provider: "meta" | "windsor" | "csv";
  status: string;
  account_name: string | null;
  external_account_id: string | null;
  currency: string;
  last_sync_at: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
  settings: Record<string, unknown>;
};

type CreativeRow = {
  creative: string;
  campaign: string | null;
  campaign_id: string | null;
  ad_id: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
};

type CampaignRow = {
  campaign: string;
  campaign_id: string | null;
  match_status: string;
  spend: number;
  impressions: number;
  clicks: number;
  players: number;
  ftd: number;
  revenue: number;
};

type OrphanAttributionRow = {
  campaign: string;
  creative: string;
  adset: string | null;
  source: string | null;
  provider: string | null;
  players: number;
  ftd: number;
  revenue: number;
};

type DbError = { message: string } | null;
type DbRow = Record<string, unknown>;
type DbResult<T = DbRow[]> = { data: T | null; error: DbError };
type DbQuery<T = DbRow[]> = PromiseLike<DbResult<T>> & {
  select: (columns: string) => DbQuery<T>;
  eq: (column: string, value: unknown) => DbQuery<T>;
  gte: (column: string, value: unknown) => DbQuery<T>;
  order: (column: string, options?: Record<string, unknown>) => DbQuery<T>;
  upsert: (value: DbRow, options?: Record<string, unknown>) => DbQuery<T>;
  single: () => Promise<DbResult<DbRow>>;
};
type DbClient = {
  rpc: (name: string) => Promise<DbResult<unknown>>;
  from: (table: string) => DbQuery;
};

async function resolveTenantId(supabase: DbClient): Promise<string> {
  const { data, error } = await supabase.rpc("current_tenant_id");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Tenant nao identificado");
  return data as string;
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function keyOf(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function emptyCreative(name: string): CreativeRow {
  return {
    creative: name,
    campaign: null,
    campaign_id: null,
    ad_id: null,
    spend: 0,
    impressions: 0,
    clicks: 0,
    players: 0,
    ftd: 0,
    revenue: 0,
  };
}

function emptyCampaign(name: string): CampaignRow {
  return {
    campaign: name,
    campaign_id: null,
    match_status: "unmatched",
    spend: 0,
    impressions: 0,
    clicks: 0,
    players: 0,
    ftd: 0,
    revenue: 0,
  };
}

function emptyOrphan(campaign: string, creative: string): OrphanAttributionRow {
  return {
    campaign,
    creative,
    adset: null,
    source: null,
    provider: null,
    players: 0,
    ftd: 0,
    revenue: 0,
  };
}

function attributionStatus(args: {
  utm_id: unknown;
  utm_content: unknown;
  utm_campaign: unknown;
  utm_source: unknown;
  adIds: Set<string>;
  creativeKeys: Set<string>;
  campaignKeys: Set<string>;
}) {
  const idKey = keyOf(args.utm_id);
  const contentKey = keyOf(args.utm_content);
  const campaignKey = keyOf(args.utm_campaign);
  if (idKey && args.adIds.has(idKey)) return "matched_ad_id";
  if (contentKey && args.creativeKeys.has(contentKey)) return "matched_ad_name";
  if (campaignKey && args.campaignKeys.has(campaignKey)) return "matched_campaign_name";
  if (idKey || contentKey || campaignKey || keyOf(args.utm_source)) return "orphan_campaign";
  return "missing_utm";
}

export const getMarketingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => overviewSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const since = new Date();
    since.setDate(since.getDate() - (data.days - 1));
    since.setHours(0, 0, 0, 0);
    const sinceDate = since.toISOString().slice(0, 10);
    const sinceIso = since.toISOString();

    const db = context.supabase as unknown as DbClient;

    const [integrationsRes, metricsRes, playersRes, attributionsRes] = await Promise.all([
      db
        .from("marketing_integrations")
        .select(
          "id, provider, status, account_name, external_account_id, currency, last_sync_at, token_expires_at, connected_at, settings",
        )
        .eq("tenant_id", tenantId)
        .order("provider"),
      db
        .from("marketing_ad_metrics_daily")
        .select(
          "provider, campaign_id, campaign_name, ad_id, ad_name, creative_name, metric_date, spend, impressions, clicks",
        )
        .eq("tenant_id", tenantId)
        .gte("metric_date", sinceDate),
      db
        .from("players")
        .select(
          "id, created_at, ftd_em, total_depositado, utm_source, utm_campaign, utm_content, utm_term, utm_id",
        )
        .eq("tenant_id", tenantId)
        .gte("created_at", sinceIso),
      db
        .from("player_attributions")
        .select(
          "player_id, provider, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, fbclid, gclid, ttclid, captured_at",
        )
        .eq("tenant_id", tenantId)
        .gte("captured_at", sinceIso),
    ]);

    if (integrationsRes.error) throw new Error(integrationsRes.error.message);
    if (metricsRes.error) throw new Error(metricsRes.error.message);
    if (playersRes.error) throw new Error(playersRes.error.message);
    if (attributionsRes.error) throw new Error(attributionsRes.error.message);

    const byCreative = new Map<string, CreativeRow>();
    const byAdId = new Map<string, CreativeRow>();
    const byCampaign = new Map<string, CampaignRow>();
    const byOrphan = new Map<string, OrphanAttributionRow>();
    const metricAdIds = new Set<string>();
    const metricCreativeKeys = new Set<string>();
    const metricCampaignKeys = new Set<string>();
    const attributionByPlayer = new Map<string, DbRow>();

    for (const row of (metricsRes.data ?? []) as DbRow[]) {
      const name = String(row.creative_name || row.ad_name || row.ad_id || "Sem criativo");
      const item = byCreative.get(keyOf(name)) ?? emptyCreative(name);
      item.campaign = item.campaign ?? row.campaign_name ?? null;
      item.campaign_id = item.campaign_id ?? (row.campaign_id as string | null) ?? null;
      item.ad_id = item.ad_id ?? row.ad_id ?? null;
      item.spend += toNumber(row.spend);
      item.impressions += toNumber(row.impressions);
      item.clicks += toNumber(row.clicks);
      byCreative.set(keyOf(name), item);
      metricCreativeKeys.add(keyOf(name));
      if (row.ad_name) metricCreativeKeys.add(keyOf(row.ad_name));
      if (row.ad_id) {
        byAdId.set(keyOf(row.ad_id), item);
        metricAdIds.add(keyOf(row.ad_id));
      }

      const campaignName = String(row.campaign_name || row.campaign_id || "Sem campanha");
      const campaign = byCampaign.get(keyOf(campaignName)) ?? emptyCampaign(campaignName);
      campaign.campaign_id = campaign.campaign_id ?? (row.campaign_id as string | null) ?? null;
      campaign.match_status = "matched_campaign_name";
      campaign.spend += toNumber(row.spend);
      campaign.impressions += toNumber(row.impressions);
      campaign.clicks += toNumber(row.clicks);
      byCampaign.set(keyOf(campaignName), campaign);
      metricCampaignKeys.add(keyOf(campaignName));
      if (row.campaign_id) metricCampaignKeys.add(keyOf(row.campaign_id));
    }

    for (const attribution of (attributionsRes.data ?? []) as DbRow[]) {
      if (attribution.player_id)
        attributionByPlayer.set(String(attribution.player_id), attribution);
    }

    let markedPlayers = 0;
    for (const player of (playersRes.data ?? []) as DbRow[]) {
      const attribution = attributionByPlayer.get(String(player.id)) ?? {};
      const utmSource = attribution.utm_source ?? player.utm_source;
      const utmCampaign = attribution.utm_campaign ?? player.utm_campaign;
      const utmContent = attribution.utm_content ?? player.utm_content;
      const utmTerm = attribution.utm_term ?? player.utm_term;
      const utmId = attribution.utm_id ?? player.utm_id;
      const contentKey = keyOf(utmContent);
      const idKey = keyOf(utmId);
      const source = keyOf(utmSource);
      if (contentKey || idKey || source) markedPlayers += 1;

      const matchStatus = attributionStatus({
        utm_id: utmId,
        utm_content: utmContent,
        utm_campaign: utmCampaign,
        utm_source: utmSource,
        adIds: metricAdIds,
        creativeKeys: metricCreativeKeys,
        campaignKeys: metricCampaignKeys,
      });
      const fallbackName = String(utmContent || utmId || utmCampaign || "(sem marcacao)");
      const item =
        (idKey ? byAdId.get(idKey) : undefined) ??
        (contentKey ? byCreative.get(contentKey) : undefined) ??
        byCreative.get(keyOf(fallbackName)) ??
        emptyCreative(fallbackName);

      item.campaign = item.campaign ?? utmCampaign ?? null;
      item.ad_id = item.ad_id ?? utmId ?? null;
      item.players += 1;
      if (player.ftd_em) item.ftd += 1;
      item.revenue += toNumber(player.total_depositado);
      byCreative.set(keyOf(item.creative), item);
      if (item.ad_id) byAdId.set(keyOf(item.ad_id), item);

      const campaignName = String(utmCampaign || "Sem campanha");
      const campaign = byCampaign.get(keyOf(campaignName)) ?? emptyCampaign(campaignName);
      campaign.match_status =
        campaign.match_status === "matched_campaign_name" ? campaign.match_status : matchStatus;
      campaign.players += 1;
      if (player.ftd_em) campaign.ftd += 1;
      campaign.revenue += toNumber(player.total_depositado);
      byCampaign.set(keyOf(campaignName), campaign);

      if (matchStatus === "orphan_campaign") {
        const creativeName = String(utmContent || utmId || "(sem criativo)");
        const orphanKey = `${keyOf(campaignName)}|${keyOf(creativeName)}`;
        const orphan = byOrphan.get(orphanKey) ?? emptyOrphan(campaignName, creativeName);
        orphan.adset = orphan.adset ?? (utmTerm as string | null) ?? null;
        orphan.source = orphan.source ?? (utmSource as string | null) ?? null;
        orphan.provider = orphan.provider ?? (attribution.provider as string | null) ?? null;
        orphan.players += 1;
        if (player.ftd_em) orphan.ftd += 1;
        orphan.revenue += toNumber(player.total_depositado);
        byOrphan.set(orphanKey, orphan);
      }
    }

    const creatives = Array.from(byCreative.values())
      .sort((a, b) => b.revenue - a.revenue || b.spend - a.spend || b.players - a.players)
      .slice(0, 50);
    const campaigns = Array.from(byCampaign.values())
      .sort((a, b) => b.revenue - a.revenue || b.spend - a.spend || b.players - a.players)
      .slice(0, 50);
    const orphanAttributions = Array.from(byOrphan.values())
      .sort((a, b) => b.revenue - a.revenue || b.players - a.players)
      .slice(0, 50);

    const spend = creatives.reduce((sum, row) => sum + row.spend, 0);
    const revenue = creatives.reduce((sum, row) => sum + row.revenue, 0);
    const players = (playersRes.data ?? []).length;
    const ftd = ((playersRes.data ?? []) as DbRow[]).filter((p) => Boolean(p.ftd_em)).length;
    const orphanPlayers = orphanAttributions.reduce((sum, row) => sum + row.players, 0);

    return {
      tenantId,
      days: data.days,
      integrations: (integrationsRes.data ?? []) as Integration[],
      totals: {
        spend,
        revenue,
        roas: spend > 0 ? revenue / spend : null,
        players,
        markedPlayers,
        orphanPlayers,
        ftd,
        cpaFtd: ftd > 0 && spend > 0 ? spend / ftd : null,
      },
      campaigns,
      creatives,
      orphanAttributions,
    };
  });

export const saveMarketingIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => saveIntegrationSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveTenantId(context.supabase);
    const db = context.supabase as unknown as DbClient;
    const { data: row, error } = await db
      .from("marketing_integrations")
      .upsert(
        {
          tenant_id: tenantId,
          provider: data.provider,
          status: data.status,
          account_name: data.account_name ?? null,
          external_account_id: data.external_account_id ?? null,
          currency: data.currency,
          settings: data.settings,
          connected_at: data.status === "connected" ? new Date().toISOString() : null,
        },
        { onConflict: "tenant_id,provider,external_account_id" },
      )
      .select(
        "id, provider, status, account_name, external_account_id, currency, last_sync_at, token_expires_at, connected_at, settings",
      )
      .single();
    if (error) throw new Error(error.message);
    return { integration: row as Integration };
  });
