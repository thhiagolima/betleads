// Voice campaign entity (`voice_campaigns`, V1-03): creation, hub listing and
// cancel. Before it existed a voice campaign was only the grouping of
// `call_queue.trigger_name`; those items (voice_campaign_id null) keep being
// listed through that grouping.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { activeTenantFilter, tenantReads } from "@/lib/active-tenant-filter";
import {
  groupVoiceQueueItems,
  summarizeVoiceCampaignCounts,
  type VoiceCampaignGroup,
  type VoiceCampaignRecord,
  type VoiceItemCount,
  type VoiceQueueItem,
} from "./channel-operation-state";

type Sb = SupabaseClient<Database>;
type QueueStatus = Database["public"]["Enums"]["call_queue_status"];

export type VoiceCampaignStatus =
  "draft" | "scheduled" | "sending" | "paused" | "cancelled" | "finished";

/** Queue statuses no dispatcher has claimed yet: a cancel may still stop them. */
export const VOICE_CANCELLABLE_QUEUE_STATUSES: QueueStatus[] = [
  "pending_audio",
  "audio_ready",
  "paused",
];
/**
 * Queue statuses that will not change any more. Only `call_queue_status` enum
 * values: a value outside the enum makes the PostgREST `in` filter fail.
 */
const VOICE_FINAL_QUEUE_STATUSES: QueueStatus[] = ["completed", "failed", "cancelled"];

/** Most recent campaigns the hub lists. */
export const VOICE_CAMPAIGNS_LIST_LIMIT = 100;
/** Legacy queue items (no campaign) the hub groups, same window as before. */
export const VOICE_LEGACY_ITEMS_LIMIT = 200;

export type CreateVoiceCampaignInput = {
  tenantId: string;
  name: string;
  scriptId: string | null;
  assetId: string | null;
  scheduledAt: string | null;
  recipientCount: number;
  createdBy: string | null;
  status: VoiceCampaignStatus;
};

/** Inserts the campaign row; throws (nothing else is created) when it fails. */
export async function createVoiceCampaign(
  supabase: Sb,
  input: CreateVoiceCampaignInput,
): Promise<string> {
  const { data, error } = await supabase
    .from("voice_campaigns")
    .insert({
      tenant_id: input.tenantId,
      name: input.name,
      dispatch_mode: "cml",
      voice_asset_id: input.assetId,
      script_id: input.scriptId,
      scheduled_at: input.scheduledAt,
      status: input.status,
      recipient_count: input.recipientCount,
      created_by: input.createdBy,
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(
      `Não foi possível criar a campanha de voz: ${error?.message ?? "sem resposta do banco"}`,
    );
  }
  return String(data.id);
}

/** Best-effort status change (the queue items stay the source of truth). */
export async function setVoiceCampaignStatus(
  supabase: Sb,
  campaignId: string,
  status: VoiceCampaignStatus,
) {
  const { error } = await supabase
    .from("voice_campaigns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (error) {
    console.error("[voice-campaigns] could not update the campaign status", {
      campaignId,
      status,
      error: error.message,
    });
  }
}

/**
 * Active house of the caller (`current_tenant_id()`, the header switcher's
 * house for a super admin), as `tenantReads` resolves it. Writes by campaign
 * id are filtered by it: RLS alone lets a super admin touch any house.
 */
async function requireActiveTenantId(supabase: Sb): Promise<string> {
  const tenantId = await activeTenantFilter(supabase);
  if (!tenantId) throw new Error("Casa ativa não encontrada.");
  return tenantId;
}

/**
 * True when the campaign was cancelled meanwhile (the "Disparar agora" loop
 * checks it before each target). A read error counts as not cancelled: the
 * conditional `pending_audio → audio_ready` update still stops a cancelled item.
 */
export async function isVoiceCampaignCancelled(
  supabase: Sb,
  campaignId: string,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("voice_campaigns")
    .select("status")
    .eq("id", campaignId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    console.error("[voice-campaigns] could not read the campaign status", {
      campaignId,
      error: error.message,
    });
    return false;
  }
  return data?.status === "cancelled";
}

/**
 * Cancels a campaign of the active house: every item no dispatcher claimed yet
 * is cancelled (a call already handed to the provider is not undone) and the
 * campaign is marked cancelled.
 */
export async function cancelVoiceCampaignFor(supabase: Sb, campaignId: string) {
  const tenantId = await requireActiveTenantId(supabase);
  const { data: campaign, error } = await supabase
    .from("voice_campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!campaign) throw new Error("Campanha de voz não encontrada.");
  if (campaign.status === "finished") {
    throw new Error("Esta campanha já foi finalizada e não pode ser cancelada.");
  }

  const { data: cancelled, error: queueError } = await supabase
    .from("call_queue")
    .update({ status: "cancelled" })
    .eq("voice_campaign_id", campaignId)
    .eq("tenant_id", tenantId)
    .in("status", VOICE_CANCELLABLE_QUEUE_STATUSES)
    .select("id");
  if (queueError) throw new Error(queueError.message);

  const { error: campaignError } = await supabase
    .from("voice_campaigns")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("tenant_id", tenantId);
  if (campaignError) throw new Error(campaignError.message);

  return { ok: true as const, cancelled: (cancelled ?? []).length };
}

/**
 * After a single queue item is cancelled (Ligações > Fila): when it was the
 * last pending call of its campaign, the campaign ends — `cancelled` when
 * nothing of it was completed or failed, `finished` otherwise. Best-effort and
 * limited to the active house (an item of another house is left alone).
 */
export async function syncVoiceCampaignAfterItemCancel(supabase: Sb, queueItemId: string) {
  try {
    const tenantId = await requireActiveTenantId(supabase);
    const { data: item } = await supabase
      .from("call_queue")
      .select("voice_campaign_id")
      .eq("id", queueItemId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const campaignId = item?.voice_campaign_id as string | null | undefined;
    if (!campaignId) return;

    const finals = `(${VOICE_FINAL_QUEUE_STATUSES.join(",")})`;
    const { count: pending, error: pendingError } = await supabase
      .from("call_queue")
      .select("id", { count: "exact", head: true })
      .eq("voice_campaign_id", campaignId)
      .eq("tenant_id", tenantId)
      .not("status", "in", finals);
    if (pendingError || (pending ?? 0) > 0) return;

    const { count: reached, error: reachedError } = await supabase
      .from("call_queue")
      .select("id", { count: "exact", head: true })
      .eq("voice_campaign_id", campaignId)
      .eq("tenant_id", tenantId)
      .neq("status", "cancelled");
    if (reachedError) return;

    const { error } = await supabase
      .from("voice_campaigns")
      .update({
        status: (reached ?? 0) > 0 ? "finished" : "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("tenant_id", tenantId)
      .neq("status", "cancelled");
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("[voice-campaigns] could not sync the campaign after a cancel", {
      queueItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type VoiceCampaignListRow = VoiceCampaignGroup & {
  /** `voice_campaigns` row (true) or a grouping of legacy queue items (false). */
  isCampaign: boolean;
  /** Entity status (`finished` derived when nothing is pending); null for legacy rows. */
  campaignStatus: string | null;
};

const LEGACY_ITEM_COLUMNS =
  "id, status, phone_number, audio_url, scheduled_at, provider_status, trigger_name, script_id, voice_asset_id, created_at";

/** True when the error says voice_campaigns / voice_campaign_id is not deployed yet. */
function isMissingSchema(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(String(error.code ?? "")) ||
    /voice_campaign/i.test(error.message ?? "")
  );
}

/**
 * Voice campaigns of the active house for the campaigns hub: the
 * `voice_campaigns` rows (counters from their queue items) plus the queue
 * items created before the entity existed, grouped by `trigger_name` like
 * before.
 */
export async function listVoiceCampaignsFor(
  supabase: Sb,
  now: number = Date.now(),
): Promise<{ campaigns: VoiceCampaignListRow[] }> {
  const { from } = await tenantReads(supabase);

  const { data: campaignRows, error: campaignError } = await from("voice_campaigns")
    .select("id, name, status, scheduled_at, created_at, recipient_count")
    .order("created_at", { ascending: false })
    .limit(VOICE_CAMPAIGNS_LIST_LIMIT);
  if (campaignError && !isMissingSchema(campaignError)) throw new Error(campaignError.message);
  const entitySchema = !campaignError;
  const campaigns = (campaignRows ?? []) as VoiceCampaignRecord[];

  // Counters come aggregated from the database (one row per campaign, status,
  // provider status and "time still ahead"), never item by item: a campaign
  // may have tens of thousands of items and the hub refreshes every 30 s.
  // The function is security invoker, so call_queue RLS still applies.
  const countsByCampaign = new Map<string, VoiceItemCount[]>();
  if (campaigns.length > 0) {
    const { data: counts, error } = await supabase.rpc("voice_campaign_item_counts", {
      p_campaign_ids: campaigns.map((campaign) => campaign.id),
      p_now: new Date(now).toISOString(),
    });
    if (error) throw new Error(error.message);
    for (const row of (counts ?? []) as VoiceItemCount[]) {
      const key = String(row.voice_campaign_id);
      const list = countsByCampaign.get(key) ?? [];
      list.push(row);
      countsByCampaign.set(key, list);
    }
  }

  let legacyQuery = from("call_queue").select(LEGACY_ITEM_COLUMNS);
  if (entitySchema) legacyQuery = legacyQuery.is("voice_campaign_id", null);
  const { data: legacyItems, error: legacyError } = await legacyQuery
    .order("created_at", { ascending: false })
    .limit(VOICE_LEGACY_ITEMS_LIMIT);
  if (legacyError) throw new Error(legacyError.message);

  // Only a one-call campaign carries its item id (the report is per call).
  const entityRows: VoiceCampaignListRow[] = campaigns.map((campaign) =>
    summarizeVoiceCampaignCounts(campaign, countsByCampaign.get(campaign.id) ?? [], now),
  );
  const legacyRows: VoiceCampaignListRow[] = groupVoiceQueueItems(
    (legacyItems ?? []) as VoiceQueueItem[],
    now,
  ).map((group) => ({ ...group, isCampaign: false, campaignStatus: null }));

  return { campaigns: [...entityRows, ...legacyRows] };
}
