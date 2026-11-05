// Web push (OneSignal) — Task 11: one tick of a claimed webpush campaign.
//
// Free of module-level I/O: every side effect goes through
// `WebpushDispatchDeps` (wired to Supabase/OneSignal in
// `runScheduledWebpushCampaigns` below), mirroring
// `sms-campaign-dispatch.server.ts`'s shape (claim → paged batches →
// lock-guarded checkpoint).
//
// Idempotency (Review Focus 3): every charge/send of a batch is keyed off
// `webpush:<campaignId>:<first subscriptionRowId of the batch>`. That key is
// fully determined by the campaign's current cursor, so a crash between the
// OneSignal call and the checkpoint simply re-derives the same key on retry:
// `reserve` comes back `idempotent: true` (no double charge), `send` is
// called with the same OneSignal idempotency key, and `writeLogs` only ever
// commits once per (campaign, subscription) because the batch itself is
// re-fetched unchanged (the real `webpush_campaign_batch` RPC excludes rows
// that already have a `webpush_send_logs` entry — nothing was written before
// the crash, so nothing is skipped; nothing after it is re-sent twice).
import { publicAppBaseUrl } from "@/lib/click-tracking.server";
import type { RefundUsageArgs, ReserveUsageArgs, ReserveUsageResult } from "@/lib/billing/wallet.server";
import { refundUsage, reserveUsage } from "@/lib/billing/wallet.server";
import { channelBudget } from "@/lib/rate-limit/channel-budget.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { loadAppCredentials } from "./apps.server";
import { campaignPushUrl, markWebpushDispatches, prepareWebpushDispatches } from "./links.server";
import { deterministicUuid, sendOneSignalPush, type OneSignalSendResult } from "./onesignal.server";

export type WebpushCampaignRow = {
  id: string;
  tenant_id: string;
  name: string;
  title: string;
  body: string;
  url: string;
  image_url: string | null;
  audience_kind: string;
  audience_criteria: unknown;
  target_player_ids: string[] | null;
  status: string;
  scheduled_at: string;
  locked_at: string | null;
  locked_by: string | null;
  sent_cursor: string | null;
  target_count: number;
  sent_count: number;
  failed_count: number;
  last_error: string | null;
  created_by: string | null;
};

/** One row of `webpush_campaign_batch` (Task 1). */
export type WebpushBatchRow = {
  subscriptionRowId: string;
  subscriptionId: string;
  playerId: string | null;
  appId: string;
  onesignalAppId: string;
  clickKey: string;
};

export type WebpushSendInput = {
  tenantId: string;
  appId: string;
  apiKey: string;
  subscriptionIds: string[];
  title: string;
  body: string;
  url: string;
  imageUrl?: string | null;
  idempotencyKey: string;
};

export type WebpushLogRow = {
  campaignId: string;
  subscriptionRowId: string;
  playerId: string | null;
  appId: string;
  onesignalNotificationId: string | null;
  status: "enviado" | "recusado";
  billingReference: string | null;
};

export type WebpushDispatchDeps = {
  now(): Date;
  nextBatch(
    campaign: WebpushCampaignRow,
    after: string | null,
    limit: number,
  ): Promise<WebpushBatchRow[]>;
  appStats(appId: string): Promise<{ sentLast15m: number; active: number }>;
  credentials(appRowId: string): Promise<{ appId: string; apiKey: string }>;
  prepareDispatches(args: {
    tenantId: string;
    campaignId: string;
    url: string;
    recipients: Array<{ subscriptionRowId: string; playerId: string | null }>;
  }): Promise<void>;
  markDispatches(args: {
    tenantId: string;
    campaignId: string;
    sentIds: string[];
    failedIds: string[];
    sentAt: Date;
  }): Promise<void>;
  reserve(args: ReserveUsageArgs): Promise<ReserveUsageResult>;
  refund(args: RefundUsageArgs): Promise<void>;
  send(input: WebpushSendInput): Promise<OneSignalSendResult>;
  deactivate(subscriptionRowIds: string[]): Promise<void>;
  writeLogs(rows: WebpushLogRow[]): Promise<void>;
  updateCampaign(campaign: WebpushCampaignRow, patch: Record<string, unknown>): Promise<boolean>;
  acquireBudget(tenantId: string): Promise<boolean>;
};

export type WebpushCampaignTickResult = {
  status: string;
  sent: number;
  failed: number;
};

/** Burst guard (Global Constraints §burst): per app, sent in the last 15 min + this batch <= 5x active subscriptions. */
export function canSendWithinBurstLimit(sentLast15m: number, batch: number, active: number): boolean {
  return sentLast15m + batch <= 5 * active;
}

function groupByApp(rows: WebpushBatchRow[]): Array<{ appId: string; rows: WebpushBatchRow[] }> {
  const groups: Array<{ appId: string; rows: WebpushBatchRow[] }> = [];
  for (const row of rows) {
    let group = groups.find((g) => g.appId === row.appId);
    if (!group) {
      group = { appId: row.appId, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** last_error of a campaign paused for lack of house balance (same text as SMS's SMS_CAMPAIGN_NO_BALANCE_MESSAGE). */
export const WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE = "Saldo insuficiente";

/**
 * Processes one claimed campaign for one tick: pages `nextBatch` up to
 * `opts.batchSize` (1000 — OneSignal's own per-call cap) at a time, grouped
 * by app (one OneSignal call per app per batch), charging the wallet before
 * each send and settling it (refund, or refund+adjusted reserve for a
 * partially-accepted batch) right after. The cursor and counters are
 * checkpointed after every full batch; a burst/budget denial, an
 * insufficient-balance refusal, or a temporary provider failure stops the
 * tick (releasing the lock so the next run picks the campaign back up)
 * without losing whatever earlier groups in that same batch already sent.
 */
export async function processWebpushCampaignTick(
  campaignRow: WebpushCampaignRow,
  deps: WebpushDispatchDeps,
  opts: { deadline: number; batchSize?: number },
): Promise<WebpushCampaignTickResult> {
  const batchSize = opts.batchSize ?? 1000;
  let c = campaignRow;
  let cursor = c.sent_cursor ?? null;
  let sentCount = c.sent_count ?? 0;
  let failedCount = c.failed_count ?? 0;

  for (;;) {
    if (deps.now().getTime() >= opts.deadline) {
      return { status: "enviando", sent: sentCount, failed: failedCount };
    }

    const batch = await deps.nextBatch(c, cursor, batchSize);
    if (batch.length === 0) {
      const finalStatus = sentCount === 0 && failedCount > 0 ? "falhou" : "enviado";
      await deps.updateCampaign(c, { status: finalStatus, locked_at: null, locked_by: null });
      return { status: finalStatus, sent: sentCount, failed: failedCount };
    }

    const groups = groupByApp(batch);
    let batchSent = 0;
    let batchFailed = 0;
    let lastProcessedId: string | null = null;
    let stopReason: "burst" | "budget" | "balance" | "temporary" | null = null;
    let stopError: string | undefined;

    for (const group of groups) {
      const stats = await deps.appStats(group.appId);
      if (!canSendWithinBurstLimit(stats.sentLast15m, group.rows.length, stats.active)) {
        stopReason = "burst";
        break;
      }
      if (!(await deps.acquireBudget(c.tenant_id))) {
        stopReason = "budget";
        break;
      }

      await deps.prepareDispatches({
        tenantId: c.tenant_id,
        campaignId: c.id,
        url: c.url,
        recipients: group.rows.map((r) => ({
          subscriptionRowId: r.subscriptionRowId,
          playerId: r.playerId,
        })),
      });

      const referenceId = `webpush:${c.id}:${group.rows[0].subscriptionRowId}`;
      const reserveResult = await deps.reserve({
        tenantId: c.tenant_id,
        item: "webpush",
        units: group.rows.length,
        referenceType: "webpush_campaign",
        referenceId,
        idempotencyKey: referenceId,
      });
      if (!reserveResult.ok) {
        stopReason = "balance";
        break;
      }

      const { appId: onesignalAppId, apiKey } = await deps.credentials(group.appId);
      const idempotencyKey = await deterministicUuid(referenceId);
      const sendResult = await deps.send({
        tenantId: c.tenant_id,
        appId: onesignalAppId,
        apiKey,
        subscriptionIds: group.rows.map((r) => r.subscriptionId),
        title: c.title,
        body: c.body,
        url: campaignPushUrl(publicAppBaseUrl(), c.id),
        imageUrl: c.image_url,
        idempotencyKey,
      });

      if (!sendResult.ok) {
        await deps.refund({
          tenantId: c.tenant_id,
          referenceId,
          idempotencyKey: `${referenceId}:refund`,
          reason: sendResult.error,
        });
        stopError = sendResult.error;
        if (sendResult.temporary) {
          stopReason = "temporary";
          break;
        }
        // Permanent failure: nothing was charged (refunded above); every
        // recipient of this group is logged `recusado` and the tick moves on.
        batchFailed += group.rows.length;
        await deps.writeLogs(
          group.rows.map((r) => ({
            campaignId: c.id,
            subscriptionRowId: r.subscriptionRowId,
            playerId: r.playerId,
            appId: r.appId,
            onesignalNotificationId: null,
            status: "recusado" as const,
            billingReference: null,
          })),
        );
        await deps.markDispatches({
          tenantId: c.tenant_id,
          campaignId: c.id,
          sentIds: [],
          failedIds: group.rows.map((r) => r.subscriptionRowId),
          sentAt: deps.now(),
        });
        lastProcessedId = group.rows[group.rows.length - 1].subscriptionRowId;
        continue;
      }

      const invalidIds = new Set(sendResult.invalidSubscriptionIds);
      const accepted = group.rows.filter((r) => !invalidIds.has(r.subscriptionId));
      const refused = group.rows.filter((r) => invalidIds.has(r.subscriptionId));

      if (refused.length > 0) {
        await deps.refund({
          tenantId: c.tenant_id,
          referenceId,
          idempotencyKey: `${referenceId}:refund`,
          reason: "OneSignal recusou parte do lote (invalid_player_ids)",
        });
        if (accepted.length > 0) {
          await deps.reserve({
            tenantId: c.tenant_id,
            item: "webpush",
            units: accepted.length,
            referenceType: "webpush_campaign",
            referenceId,
            idempotencyKey: `${referenceId}:ajuste`,
          });
        }
        await deps.deactivate(refused.map((r) => r.subscriptionRowId));
      }

      batchSent += accepted.length;
      batchFailed += refused.length;

      await deps.writeLogs([
        ...accepted.map((r) => ({
          campaignId: c.id,
          subscriptionRowId: r.subscriptionRowId,
          playerId: r.playerId,
          appId: r.appId,
          onesignalNotificationId: sendResult.notificationId,
          status: "enviado" as const,
          billingReference: referenceId,
        })),
        ...refused.map((r) => ({
          campaignId: c.id,
          subscriptionRowId: r.subscriptionRowId,
          playerId: r.playerId,
          appId: r.appId,
          onesignalNotificationId: sendResult.notificationId,
          status: "recusado" as const,
          billingReference: null,
        })),
      ]);

      await deps.markDispatches({
        tenantId: c.tenant_id,
        campaignId: c.id,
        sentIds: accepted.map((r) => r.subscriptionRowId),
        failedIds: refused.map((r) => r.subscriptionRowId),
        sentAt: deps.now(),
      });

      lastProcessedId = group.rows[group.rows.length - 1].subscriptionRowId;
    }

    if (lastProcessedId) cursor = lastProcessedId;
    sentCount += batchSent;
    failedCount += batchFailed;

    if (stopReason === "balance") {
      await deps.updateCampaign(c, {
        status: "pausada",
        last_error: WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE,
        sent_cursor: cursor,
        sent_count: sentCount,
        failed_count: failedCount,
        locked_at: null,
        locked_by: null,
      });
      return { status: "pausada", sent: sentCount, failed: failedCount };
    }

    if (stopReason === "burst" || stopReason === "budget" || stopReason === "temporary") {
      await deps.updateCampaign(c, {
        status: "enviando",
        sent_cursor: cursor,
        sent_count: sentCount,
        failed_count: failedCount,
        ...(stopError ? { last_error: stopError } : {}),
        locked_at: null,
        locked_by: null,
      });
      return { status: "enviando", sent: sentCount, failed: failedCount };
    }

    // Checkpoint after the whole batch; the loop repeats until the deadline
    // or an empty batch (done). A lost lock (another worker re-claimed the
    // campaign) stops the tick without touching the row any further.
    const ok = await deps.updateCampaign(c, {
      sent_cursor: cursor,
      sent_count: sentCount,
      failed_count: failedCount,
      locked_at: deps.now().toISOString(),
    });
    if (!ok) return { status: "enviando", sent: sentCount, failed: failedCount };
    c = { ...c, sent_cursor: cursor, sent_count: sentCount, failed_count: failedCount };
  }
}

// ============================================================================
// Real wiring — claims due campaigns and ticks each one within a shared
// per-run time budget, mirroring `runScheduledSmsCampaigns`.
// ============================================================================

const WEBPUSH_CAMPAIGN_JOB = "webpush_campaign_dispatch";
/** Per-run time budget shared by every campaign claimed in this tick (cron runs once a minute). */
const WEBPUSH_CAMPAIGN_RUN_BUDGET_MS = 45_000;

const webpushDb = supabaseAdmin as unknown as {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any -- generated types don't cover these RPC return rows yet.
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

/** Icon URL cached per tenant for the lifetime of one dispatcher run. */
function iconUrlLoader() {
  const cache = new Map<string, Promise<string | null>>();
  return async function loadIconUrl(tenantId: string): Promise<string | null> {
    const cached = cache.get(tenantId);
    if (cached) return cached;
    const promise: Promise<string | null> = webpushDb
      .from("tenant_webpush_settings")
      .select("icon_url")
      .eq("tenant_id", tenantId)
      .maybeSingle()
      .then(({ data }: { data: unknown }) => (data as { icon_url: string | null } | null)?.icon_url ?? null);
    cache.set(tenantId, promise);
    return promise;
  };
}

function realWebpushDeps(loadIconUrl: (tenantId: string) => Promise<string | null>): WebpushDispatchDeps {
  return {
    now: () => new Date(),
    async nextBatch(campaign, after, limit) {
      const { data, error } = await webpushDb.rpc("webpush_campaign_batch", {
        p_campaign: campaign.id,
        p_after: after,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{
        subscription_row_id: string;
        subscription_id: string;
        player_id: string | null;
        app_id: string;
        onesignal_app_id: string;
        click_key: string;
      }>).map((r) => ({
        subscriptionRowId: r.subscription_row_id,
        subscriptionId: r.subscription_id,
        playerId: r.player_id,
        appId: r.app_id,
        onesignalAppId: r.onesignal_app_id,
        clickKey: r.click_key,
      }));
    },
    async appStats(appId) {
      const [{ data: sentData, error: sentError }, { data: activeData, error: activeError }] =
        await Promise.all([
          webpushDb.rpc("webpush_app_sent_last_15m", { p_app: appId }),
          webpushDb.rpc("webpush_app_active_count", { p_app: appId }),
        ]);
      if (sentError) throw new Error(sentError.message);
      if (activeError) throw new Error(activeError.message);
      return { sentLast15m: Number(sentData ?? 0), active: Number(activeData ?? 0) };
    },
    credentials: (appRowId) => loadAppCredentials(webpushDb, appRowId),
    prepareDispatches: (args) => prepareWebpushDispatches(webpushDb, args),
    markDispatches: (args) => markWebpushDispatches(webpushDb, args),
    reserve: (args) => reserveUsage(webpushDb, args),
    refund: (args) => refundUsage(webpushDb, args),
    async send(input) {
      const iconUrl = await loadIconUrl(input.tenantId);
      return sendOneSignalPush({
        appId: input.appId,
        apiKey: input.apiKey,
        subscriptionIds: input.subscriptionIds,
        title: input.title,
        body: input.body,
        url: input.url,
        imageUrl: input.imageUrl,
        iconUrl,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async deactivate(subscriptionRowIds) {
      if (subscriptionRowIds.length === 0) return;
      const { error } = await webpushDb
        .from("push_subscriptions")
        .update({ status: "inativa" })
        .in("id", subscriptionRowIds);
      if (error) throw new Error(error.message);
    },
    async writeLogs(rows) {
      if (rows.length === 0) return;
      const { error } = await webpushDb.from("webpush_send_logs").upsert(
        rows.map((r) => ({
          campaign_id: r.campaignId,
          subscription_row_id: r.subscriptionRowId,
          player_id: r.playerId,
          app_id: r.appId,
          onesignal_notification_id: r.onesignalNotificationId,
          status: r.status,
          billing_reference: r.billingReference,
        })),
        { onConflict: "campaign_id,subscription_row_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    },
    async updateCampaign(campaign, patch) {
      let query = webpushDb.from("webpush_campaigns").update(patch).eq("id", campaign.id);
      // Only writes while this worker still holds the campaign's lock.
      if (campaign.locked_by) query = query.eq("locked_by", campaign.locked_by);
      const { data, error } = await query.select("id");
      if (error) {
        console.error("[webpush-campaigns] falha ao atualizar campanha", {
          campaignId: campaign.id,
          error: error.message,
        });
        return false;
      }
      return Array.isArray(data) && data.length > 0;
    },
    acquireBudget: async (tenantId) => {
      const admission = await channelBudget.acquire(tenantId, "webpush", {
        deadline: Date.now() + WEBPUSH_CAMPAIGN_RUN_BUDGET_MS,
      });
      return admission.ok;
    },
  };
}

export type RunScheduledWebpushCampaignsResult = {
  claimed: number;
  results: Array<{ campaignId: string; status: string; sent: number; failed: number }>;
};

/**
 * Claims due webpush campaigns (`claim_due_webpush_campaigns`) and ticks each
 * one with `processWebpushCampaignTick` inside a single shared per-run time
 * budget (the cron runs once a minute). A campaign that throws mid-tick is
 * put back to `enviando` with the lock released so the next run retries it;
 * one still running past the budget just has its lock released untouched.
 */
export async function runScheduledWebpushCampaigns({
  limit = 10,
}: { limit?: number } = {}): Promise<RunScheduledWebpushCampaignsResult> {
  const { data: claimed, error: claimErr } = await webpushDb.rpc("claim_due_webpush_campaigns", {
    p_limit: limit,
  });
  if (claimErr) {
    console.error("[webpush-campaigns] claim falhou", claimErr);
    const failedRun = await startJobRun(WEBPUSH_CAMPAIGN_JOB, { channel: "webpush", kind: "campaign" });
    await failedRun.fail(new Error(`claim_due_webpush_campaigns: ${claimErr.message}`), {
      provider: "onesignal",
    });
    return { claimed: 0, results: [] };
  }
  const campaigns = (claimed ?? []) as unknown as WebpushCampaignRow[];
  if (campaigns.length === 0) return { claimed: 0, results: [] };

  const run = await startJobRun(WEBPUSH_CAMPAIGN_JOB, {
    channel: "webpush",
    kind: "campaign",
    provider: "onesignal",
  });
  run.progress({ queue_before: campaigns.length, claimed: campaigns.length });

  const loadIconUrl = iconUrlLoader();
  const deps = realWebpushDeps(loadIconUrl);
  const deadline = Date.now() + WEBPUSH_CAMPAIGN_RUN_BUDGET_MS;

  const results: RunScheduledWebpushCampaignsResult["results"] = [];
  let totalSent = 0;
  let totalFailed = 0;
  try {
    for (const c of campaigns) {
      if (Date.now() >= deadline) {
        await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
        continue;
      }
      try {
        const r = await processWebpushCampaignTick(c, deps, { deadline });
        totalSent += r.sent;
        totalFailed += r.failed;
        results.push({ campaignId: c.id, status: r.status, sent: r.sent, failed: r.failed });
      } catch (error) {
        console.error("[webpush-campaigns] falha ao processar campanha", {
          campaignId: c.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await deps.updateCampaign(c, {
          status: "enviando",
          last_error: error instanceof Error ? error.message.slice(0, 500) : String(error),
          locked_at: null,
          locked_by: null,
        });
      }
      run.progress({ sent: totalSent, errors: totalFailed });
    }
    await run.finish({ queue_before: campaigns.length, claimed: campaigns.length, sent: totalSent, errors: totalFailed });
  } catch (error) {
    await run.fail(error);
    throw error;
  }

  return { claimed: campaigns.length, results };
}
