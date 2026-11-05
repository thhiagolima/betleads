// Web push (OneSignal) — Task 9: a tracked link per subscription and the
// click route it resolves.
//
// OneSignal substitutes the `blk` tag into the notification URL at send
// time (one OneSignal call per batch, not per recipient — Global
// Constraints §6 "Tags OneSignal: uma única tag `blk`"), so every
// `link_dispatches` row of a campaign shares the same literal
// `campaignPushUrl()` template; only `idempotency_key`/`recipient_*` vary
// per subscription. The click route then re-derives which subscription
// clicked from `key` (push_subscriptions.click_key) and `campaignId` alone —
// no extra column is needed, since the idempotency_key already encodes
// (campaignId, subscriptionRowId).
import { createHash, randomUUID } from "node:crypto";

import { buildFirstPartyClickUrl } from "@/lib/click-tracking.server";
import { getOrCreateFirstPartyTrackedLink } from "@/lib/shortio.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double (createFakeDb). */
export type WebpushLinksDb = { from: (table: string) => any };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLICK_KEY_PATTERN = /^[0-9a-f]{32}$/;

function publicAppUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ??
    process.env.VITE_PUBLIC_APP_URL ??
    "https://betleads.io"
  ).replace(/\/+$/, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function webpushIdempotencyKey(campaignId: string, subscriptionRowId: string): string {
  return `webpush:${campaignId}:${subscriptionRowId}:0`;
}

/**
 * Public click URL for one campaign. The `blk` placeholder is literal Liquid
 * syntax for OneSignal (never URL-encoded here): OneSignal renders it per
 * recipient from the `blk` tag, falling back to `"x"` (an unknown 32-hex
 * pattern) when the tag is missing — the click route then redirects to the
 * campaign's own URL instead of 404ing (Review Focus 4).
 */
export function campaignPushUrl(apiBase: string, campaignId: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return `${base}/api/public/push/c/${campaignId}/{{ blk | default: "x" }}`;
}

export type PrepareWebpushDispatchesInput = {
  tenantId: string;
  campaignId: string;
  url: string;
  recipients: Array<{ subscriptionRowId: string; playerId: string | null }>;
};

/**
 * One first-party `tracked_links` row per campaign (shared destination), and
 * one `link_dispatches` row per subscription — identified, or anonymous with
 * `recipient_hash`. Idempotent: re-running for the same campaign/subscription
 * inserts nothing new (`ignoreDuplicates` on the `(tenant_id,
 * idempotency_key)` unique index, same pattern as `persistDispatch` in
 * shortio.server.ts).
 */
export async function prepareWebpushDispatches(
  db: WebpushLinksDb,
  input: PrepareWebpushDispatchesInput,
): Promise<void> {
  if (input.recipients.length === 0) return;

  const tracked = await getOrCreateFirstPartyTrackedLink(input.tenantId, input.url);
  const sentUrl = campaignPushUrl(publicAppUrl(), input.campaignId);

  const rows = input.recipients.map((recipient) => ({
    tenant_id: input.tenantId,
    idempotency_key: webpushIdempotencyKey(input.campaignId, recipient.subscriptionRowId),
    tracked_link_id: tracked.id,
    tracking_token: randomUUID(),
    channel: "webpush",
    recipient_player_id: recipient.playerId ?? null,
    recipient_hash: recipient.playerId
      ? null
      : sha256Hex(`webpush:${recipient.subscriptionRowId}`),
    source_type: "campaign",
    source_id: input.campaignId,
    url_position: 0,
    original_url: input.url,
    sent_url: sentUrl,
    send_status: "prepared",
  }));

  const { error } = await db
    .from("link_dispatches")
    .upsert(rows, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  if (error) throw new Error(`Falha ao preparar dispatches de push: ${error.message}`);
}

export type MarkWebpushDispatchesInput = {
  tenantId: string;
  campaignId: string;
  sentIds: string[];
  failedIds: string[];
  sentAt: Date;
};

/** Marks the `link_dispatches` rows of this batch as sent or failed. */
export async function markWebpushDispatches(
  db: WebpushLinksDb,
  input: MarkWebpushDispatchesInput,
): Promise<void> {
  const sentAtIso = input.sentAt.toISOString();

  if (input.sentIds.length > 0) {
    const keys = input.sentIds.map((id) => webpushIdempotencyKey(input.campaignId, id));
    const { error } = await db
      .from("link_dispatches")
      .update({ send_status: "sent", sent_at: sentAtIso })
      .eq("tenant_id", input.tenantId)
      .in("idempotency_key", keys);
    if (error) throw new Error(`Falha ao marcar dispatches de push como enviados: ${error.message}`);
  }

  if (input.failedIds.length > 0) {
    const keys = input.failedIds.map((id) => webpushIdempotencyKey(input.campaignId, id));
    const { error } = await db
      .from("link_dispatches")
      .update({ send_status: "failed" })
      .eq("tenant_id", input.tenantId)
      .in("idempotency_key", keys);
    if (error) throw new Error(`Falha ao marcar dispatches de push como falhos: ${error.message}`);
  }
}

export type ResolveWebpushClickInput = { campaignId: string; key: string };

type CampaignRow = { id: string; tenant_id: string; url: string };
type SubscriptionRow = { id: string; tenant_id: string };
type DispatchRow = { tracking_token: string; send_status: string };

/**
 * The 302 destination for a push click. Fails safe at every step — invalid
 * `campaignId`, unknown campaign, missing/garbage `key`, unmatched
 * subscription, or a dispatch that isn't `sent` yet all fall back to the
 * campaign's own URL (or, with no campaign at all, `PUBLIC_APP_URL`); only a
 * fully resolved subscription + sent dispatch gets the signed first-party
 * click URL that feeds attribution.
 */
export async function resolveWebpushClick(
  db: WebpushLinksDb,
  input: ResolveWebpushClickInput,
): Promise<string> {
  if (!UUID_PATTERN.test(input.campaignId)) return publicAppUrl();

  const { data: campaignData, error: campaignError } = await db
    .from("webpush_campaigns")
    .select("id,tenant_id,url")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (campaignError) throw new Error(`Falha ao resolver campanha de push: ${campaignError.message}`);
  const campaign = campaignData as CampaignRow | null;
  if (!campaign) return publicAppUrl();

  if (CLICK_KEY_PATTERN.test(input.key)) {
    const { data: subscriptionData, error: subscriptionError } = await db
      .from("push_subscriptions")
      .select("id,tenant_id")
      .eq("click_key", input.key)
      .maybeSingle();
    if (subscriptionError) {
      throw new Error(`Falha ao resolver inscrição de push: ${subscriptionError.message}`);
    }
    const subscription = subscriptionData as SubscriptionRow | null;
    if (subscription && subscription.tenant_id === campaign.tenant_id) {
      const { data: dispatchData, error: dispatchError } = await db
        .from("link_dispatches")
        .select("tracking_token,send_status")
        .eq("tenant_id", campaign.tenant_id)
        .eq("idempotency_key", webpushIdempotencyKey(input.campaignId, subscription.id))
        .maybeSingle();
      if (dispatchError) throw new Error(`Falha ao resolver dispatch de push: ${dispatchError.message}`);
      const dispatch = dispatchData as DispatchRow | null;
      if (dispatch && dispatch.send_status === "sent") {
        return await buildFirstPartyClickUrl(dispatch.tracking_token);
      }
    }
  }

  return campaign.url;
}
