// Web push (OneSignal) — Task 10: campaign creation, listing, cancellation
// and the audience/cost estimate shown on the composer. `db` is always
// `supabaseAdmin` in production; tests pass `createFakeDb().client`.
import { RESOLUTION_CHUNK_SIZE } from "@/lib/campaign-recipients.server";
import { resolveAudienceForTenant, type SelectionDb } from "@/lib/sms-audience-selection.server";
import { assertDestinationAllowed } from "@/lib/shortio.server";
import { validateCampaignContent } from "@/lib/webpush/shared";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double (createFakeDb). */
export type WebpushCampaignsDb = SelectionDb & { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type WebpushAudience = { kind: "todos" } | { kind: "filtro"; criteria: unknown };

const WEBPUSH_ID_CHUNK = RESOLUTION_CHUNK_SIZE;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Apps of a house in any of the given statuses; `ativo`+`legado` both still receive sends. */
async function fetchAppIdsByStatus(
  db: WebpushCampaignsDb,
  tenantId: string,
  statuses: string[],
): Promise<string[]> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("status", statuses);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * Whether the house has at least one app that passed the test push — an app
 * still `instalando` has not, even if it exists.
 */
async function hasActiveApp(db: WebpushCampaignsDb, tenantId: string): Promise<boolean> {
  const { data, error } = await db
    .from("tenant_webpush_apps")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "ativo")
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[]).length > 0;
}

/**
 * Active subscriptions of the given apps, optionally restricted to a set of
 * player ids (the `filtro` audience) — chunked to avoid PostgREST `in`
 * URL-length limits on a large player list. `appIds` empty, or `playerIds`
 * given and empty, both short-circuit to 0 without a query.
 */
async function countActiveSubscriptions(
  db: WebpushCampaignsDb,
  tenantId: string,
  appIds: string[],
  playerIds?: string[],
): Promise<number> {
  if (appIds.length === 0) return 0;
  if (playerIds && playerIds.length === 0) return 0;

  const idChunks = playerIds ? chunk(playerIds, WEBPUSH_ID_CHUNK) : [null];
  let total = 0;
  for (const part of idChunks) {
    let query = db
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "ativa")
      .in("app_id", appIds);
    if (part) query = query.in("player_id", part);
    const { error, count } = await query;
    if (error) throw new Error(error.message);
    total += count ?? 0;
  }
  return total;
}

/** The webpush unit price for a house: 0 when the house's plan is exempt (plano interno). */
async function resolveWebpushUnitPrice(db: WebpushCampaignsDb, tenantId: string): Promise<number> {
  const { data, error } = await db.rpc("billing_effective_price", {
    _tenant: tenantId,
    _item: "webpush",
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as { unit_price?: number | string | null; exempt?: boolean | null };
  if (row.exempt === true) return 0;
  return Number(row.unit_price ?? 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type WebpushAudienceCount = {
  subscriptions: number;
  players: number | null;
  unitPrice: number;
  estimatedCost: number;
};

/**
 * The composer estimate: how many subscriptions a campaign would reach and
 * at what cost. `todos` counts every active subscription of an `ativo`/
 * `legado` app; `filtro` resolves the audience criteria to player ids first
 * (same resolver the SMS composer uses) and counts only their active
 * subscriptions. `players` is `null` for `todos` (no identity filter
 * applies — anonymous subscriptions count too).
 */
export async function countWebpushAudience(
  db: WebpushCampaignsDb,
  tenantId: string,
  audience: WebpushAudience,
): Promise<WebpushAudienceCount> {
  const unitPrice = await resolveWebpushUnitPrice(db, tenantId);
  const appIds = await fetchAppIdsByStatus(db, tenantId, ["ativo", "legado"]);

  if (audience.kind === "todos") {
    const subscriptions = await countActiveSubscriptions(db, tenantId, appIds);
    return { subscriptions, players: null, unitPrice, estimatedCost: round2(subscriptions * unitPrice) };
  }

  const resolved = await resolveAudienceForTenant(db, tenantId, audience.criteria, undefined, {
    includePlayerIds: true,
  });
  const playerIds = resolved.playerIds ?? [];
  const subscriptions = await countActiveSubscriptions(db, tenantId, appIds, playerIds);
  return {
    subscriptions,
    players: playerIds.length,
    unitPrice,
    estimatedCost: round2(subscriptions * unitPrice),
  };
}

export type ScheduleWebpushCampaignInput = {
  tenantId: string;
  name: string;
  title: string;
  body: string;
  url: string;
  imageUrl?: string | null;
  audience: WebpushAudience;
  /** `null` = send now; otherwise must be at least 60s in the future. */
  scheduledAt: string | null;
  createdBy?: string | null;
};

function resolveScheduledAt(scheduledAt: string | null): Date {
  if (scheduledAt === null) return new Date();
  const parsed = new Date(scheduledAt);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Data/hora inválida");
  if (parsed.getTime() < Date.now() + 60_000) {
    throw new Error("O agendamento precisa estar pelo menos 60 segundos no futuro");
  }
  return parsed;
}

/**
 * Creates a push campaign: validates content (title/body/url/image, same
 * rules as the composer preview) and the destination (`assertDestinationAllowed`,
 * same policy as other house-configured sends), refuses when the house has
 * no app that passed the test push, and resolves+freezes the audience at
 * creation time — `todos` targets every active subscription of an
 * `ativo`/`legado` app (`target_player_ids` stays `null`); `filtro` resolves
 * the criteria to player ids right away and stores both the criteria and the
 * resolved ids, so the worker's dispatch batch (`webpush_campaign_batch`)
 * never has to re-run the audience resolver.
 */
export async function scheduleWebpushCampaign(
  db: WebpushCampaignsDb,
  input: ScheduleWebpushCampaignInput,
): Promise<{ id: string }> {
  const content = validateCampaignContent({
    title: input.title,
    body: input.body,
    url: input.url,
    imageUrl: input.imageUrl,
  });

  const name = (input.name ?? "").trim();
  if (!name) throw new Error("O nome da campanha é obrigatório");

  const scheduledAt = resolveScheduledAt(input.scheduledAt);

  await assertDestinationAllowed({ tenantId: input.tenantId, url: content.url });

  if (!(await hasActiveApp(db, input.tenantId))) {
    throw new Error("Web Push não instalado nesta casa");
  }

  const appIds = await fetchAppIdsByStatus(db, input.tenantId, ["ativo", "legado"]);

  let audienceKind: "todos" | "filtro";
  let audienceCriteria: unknown = null;
  let targetPlayerIds: string[] | null = null;
  let targetCount: number;

  if (input.audience.kind === "todos") {
    audienceKind = "todos";
    targetCount = await countActiveSubscriptions(db, input.tenantId, appIds);
  } else {
    audienceKind = "filtro";
    const resolved = await resolveAudienceForTenant(
      db,
      input.tenantId,
      input.audience.criteria,
      undefined,
      { includePlayerIds: true },
    );
    const playerIds = resolved.playerIds ?? [];
    audienceCriteria = input.audience.criteria;
    targetPlayerIds = playerIds;
    targetCount = await countActiveSubscriptions(db, input.tenantId, appIds, playerIds);
  }

  const { data, error } = await db
    .from("webpush_campaigns")
    .insert({
      tenant_id: input.tenantId,
      name,
      title: content.title,
      body: content.body,
      url: content.url,
      image_url: content.imageUrl,
      audience_kind: audienceKind,
      audience_criteria: audienceKind === "filtro" ? audienceCriteria : null,
      target_player_ids: targetPlayerIds,
      status: "agendada",
      scheduled_at: scheduledAt.toISOString(),
      target_count: targetCount,
      sent_count: 0,
      failed_count: 0,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id };
}

export type WebpushCampaignSummary = {
  id: string;
  name: string;
  status: string;
  scheduledAt: string;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
};

type WebpushCampaignRow = {
  id: string;
  name: string;
  status: string;
  scheduled_at: string;
  target_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
};

/** A house's push campaigns, most recently scheduled first. */
export async function listWebpushCampaigns(
  db: WebpushCampaignsDb,
  tenantId: string,
): Promise<WebpushCampaignSummary[]> {
  const { data, error } = await db
    .from("webpush_campaigns")
    .select("id,name,status,scheduled_at,target_count,sent_count,failed_count,created_at")
    .eq("tenant_id", tenantId)
    .order("scheduled_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as WebpushCampaignRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    scheduledAt: row.scheduled_at,
    targetCount: row.target_count,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
  }));
}

const CANCELLABLE_WEBPUSH_CAMPAIGN_STATUSES = ["agendada", "pausada"];

/** Cancels a push campaign — only while it's still `agendada`/`pausada`. */
export async function cancelWebpushCampaign(
  db: WebpushCampaignsDb,
  input: { tenantId: string; id: string },
): Promise<{ ok: true }> {
  const { data: current, error: readError } = await db
    .from("webpush_campaigns")
    .select("id,status")
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const previousStatus = (current as { status?: string } | null)?.status;
  if (!previousStatus || !CANCELLABLE_WEBPUSH_CAMPAIGN_STATUSES.includes(previousStatus)) {
    throw new Error("Campanha não pode mais ser cancelada");
  }

  const { data: updated, error } = await db
    .from("webpush_campaigns")
    .update({ status: "cancelada" })
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId)
    .eq("status", previousStatus)
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated || (updated as unknown[]).length === 0) {
    throw new Error("Campanha não pode mais ser cancelada");
  }
  return { ok: true };
}
