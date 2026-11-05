// Web push (OneSignal) — Task 11: one tick of a claimed webpush campaign.
//
// Fix round 1 (controller ruling —
// .superpowers/sdd/2026-11-05-web-push-onesignal/task-11-ruling.md,
// supersedes the original brief's steps 3-7): every OneSignal call for one
// (campaign, app) slice of a dispatch page is first persisted as a
// `webpush_dispatch_batches` row (migration
// 20261210100300_webpush_dispatch_batches.sql) BEFORE any money moves, and
// every later step resumes that exact row by id. This matters because the
// real wallet RPCs (20261022100100_billing_wallet.sql) have two properties
// the original design (deriving its wallet key from "the current page")
// got wrong:
//   - `wallet_mutation` dedupes FOREVER on (tenant_id, idempotency_key) —
//     even a refunded reservation's key can never be reused for a new
//     charge, so "refund on temporary failure, re-reserve with the same key
//     on retry" charges nothing on the retry (the retry's reserve just
//     returns the old, refunded reservation as `idempotent: true`).
//   - `wallet_refund` refunds only the NEWEST `usage_reservation` row for a
//     reference_id, so reusing a reference_id for two different charges
//     makes the older one unreachable.
// Both are pinned against the real SQL in
// src/lib/billing/wallet-reserve-refund-semantics.db.test.ts.
//
// State machine per batch (every step idempotent and resumable by re-running
// `advanceBatch` on the same persisted row):
//   pendente  -> reserve(batch.id) [stays pendente + reserved across a
//                temporary send failure — NEVER refunded there] -> send
//                -> enviado (ok) | falhou (permanent failure: refund once,
//                all rows refused)
//   enviado   -> settle: fully accepted -> liquidado; partially accepted ->
//                refund(batch.id) once, then (if any accepted) a FRESH
//                reserve(`${batch.id}:ajuste`) for just the accepted units
//                -> liquidado. The adjustment reservation failing pauses the
//                campaign with the batch left `enviado` (next tick retries
//                settlement before sending anything new).
//   liquidado / falhou -> writeLogs + markDispatches (both idempotent) ->
//                concluido. `liquidado` also deactivates its refused rows
//                (OneSignal reported them invalid/not subscribed); `falhou`
//                never does — a whole-call failure (bad key, malformed
//                request, ...) says nothing about subscription validity.
//
// Cursor: a freshly fetched page creates batches for ALL of its app-groups
// or NONE of them (a burst/budget denial on any group aborts the whole page,
// no batch is created, nothing moves) — so by induction the set of
// `concluido` batches for a campaign, whenever no batch is open
// (pendente/enviado/liquidado/falhou), is always an exact, gap-free prefix
// of `push_subscriptions` rows. That is the only moment it's safe to advance
// `sent_cursor` (to the max row id among concluido batches) and refresh
// `sent_count`/`failed_count` (recomputed from a SUM over concluido batches,
// never incremented — incrementing would risk double-counting if a crash
// landed between "add to counter" and "mark batch concluido").
import { publicAppBaseUrl } from "@/lib/click-tracking.server";
import type { RefundUsageArgs, ReserveUsageArgs, ReserveUsageResult } from "@/lib/billing/wallet.server";
import { reserveUsage } from "@/lib/billing/wallet.server";
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

/** One row of `webpush_campaign_batch` (Task 1) — a dispatch page before it's split into per-app batches. */
export type WebpushBatchRow = {
  subscriptionRowId: string;
  subscriptionId: string;
  playerId: string | null;
  appId: string;
  onesignalAppId: string;
  clickKey: string;
};

export type WebpushDispatchBatchStatus = "pendente" | "enviado" | "liquidado" | "concluido" | "falhou";

/** One `webpush_dispatch_batches` row (Task 11 fix round 1). */
export type WebpushDispatchBatch = {
  id: string;
  tenantId: string;
  campaignId: string;
  appId: string;
  subscriptionRowIds: string[];
  units: number;
  status: WebpushDispatchBatchStatus;
  accepted: number | null;
  refusedRowIds: string[] | null;
  onesignalNotificationId: string | null;
  lastError: string | null;
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

/** `subscription_id`/`player_id` of a stored batch's `subscription_row_ids`, re-read at resume time. */
export type WebpushRowDetail = {
  subscriptionRowId: string;
  subscriptionId: string;
  playerId: string | null;
};

export type WebpushConcludedTotals = {
  /** Max subscription_row_id among `concluido` batches, or null when there are none yet. */
  maxRowId: string | null;
  sent: number;
  failed: number;
};

export type WebpushDispatchDeps = {
  now(): Date;
  /** Pages `webpush_campaign_batch`: eligible subscriptions after `after`, up to `limit`. */
  nextBatch(
    campaign: WebpushCampaignRow,
    after: string | null,
    limit: number,
  ): Promise<WebpushBatchRow[]>;
  appStats(appId: string): Promise<{ sentLast15m: number; active: number }>;
  credentials(appRowId: string): Promise<{ appId: string; apiKey: string }>;
  acquireBudget(tenantId: string): Promise<boolean>;
  /** Persists a new `pendente` batch row for one app-group of a page. */
  createBatch(input: {
    tenantId: string;
    campaignId: string;
    appId: string;
    subscriptionRowIds: string[];
    units: number;
  }): Promise<WebpushDispatchBatch>;
  /** Non-terminal batches of this campaign, oldest first: pendente/enviado/liquidado/falhou. */
  listOpenBatches(campaignId: string): Promise<WebpushDispatchBatch[]>;
  updateBatch(batchId: string, patch: Record<string, unknown>): Promise<WebpushDispatchBatch>;
  rowDetails(subscriptionRowIds: string[]): Promise<WebpushRowDetail[]>;
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
  /**
   * MUST throw on a transient/transport failure (RPC error, network error) —
   * never swallow it the way `refundUsage` in wallet.server.ts does (fix
   * round 2: that swallowing let the state machine treat a refund that
   * never happened as done, settling/failing the batch without the money
   * ever coming back). A refusal that means "there is nothing left to
   * refund" (`reservation_not_found`, `already_refunded`) is the one case
   * that resolves normally (the batch proceeds) rather than throwing.
   */
  refund(args: RefundUsageArgs): Promise<void>;
  send(input: WebpushSendInput): Promise<OneSignalSendResult>;
  deactivate(subscriptionRowIds: string[]): Promise<void>;
  writeLogs(rows: WebpushLogRow[]): Promise<void>;
  updateCampaign(campaign: WebpushCampaignRow, patch: Record<string, unknown>): Promise<boolean>;
  /** SUM over `concluido` batches: authoritative sent/failed + the cursor ceiling. Recomputed, never incremented. */
  concludedTotals(campaignId: string): Promise<WebpushConcludedTotals>;
};

export type WebpushCampaignTickResult = {
  status: string;
  sent: number;
  failed: number;
};

/** Burst guard (Global Constraints): per app, sent in the last 15 min + this batch <= 5x active subscriptions. */
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

/** last_error of a campaign paused because the initial reservation of a batch found no balance. */
export const WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE = "Saldo insuficiente";
/** last_error of a campaign paused because settling an already-sent batch (the `:ajuste` reserve) found no balance. */
export const WEBPUSH_SETTLEMENT_NO_BALANCE_MESSAGE = "Saldo insuficiente para liquidar envio";

type AdvanceOutcome =
  | { kind: "concluded"; accepted: number; refused: number }
  | { kind: "stop-temporary" }
  | { kind: "stop-insufficient-initial" }
  | { kind: "stop-insufficient-settlement" };

/**
 * Drives one `webpush_dispatch_batches` row through as much of its state
 * machine as it can in one go, resuming from whatever status it's
 * currently in. Every step it performs is safe to re-run (idempotent wallet
 * calls, an idempotent OneSignal call, idempotent log/dispatch upserts), so
 * calling this again on the same batch after a crash picks up exactly where
 * it left off.
 */
async function advanceBatch(
  batchRow: WebpushDispatchBatch,
  c: WebpushCampaignRow,
  deps: WebpushDispatchDeps,
): Promise<AdvanceOutcome> {
  let batch = batchRow;

  for (;;) {
    if (batch.status === "pendente") {
      const referenceId = batch.id;
      const reserveResult = await deps.reserve({
        tenantId: c.tenant_id,
        item: "webpush",
        units: batch.units,
        referenceType: "webpush_campaign",
        referenceId,
        idempotencyKey: referenceId,
      });
      if (!reserveResult.ok) {
        // Fix round 2: do NOT delete the batch — a failed reserve writes no
        // ledger row (the idempotency key stays free), so the batch simply
        // stays `pendente` and the next resume retries this same reserve
        // call. Deleting it here (as the original fix did) let a SIBLING
        // batch of the same page reach `concluido` on its own while this
        // one vanished — the cursor-flush then advanced past this batch's
        // (never sent) rows forever, since nothing was left to mark them
        // open. Leaving it `pendente` keeps the campaign's "no open batch"
        // cursor-flush invariant intact (see module header): the cursor
        // can't advance past this page until this batch is also resolved.
        return { kind: "stop-insufficient-initial" };
      }

      const rows = await deps.rowDetails(batch.subscriptionRowIds);
      await deps.prepareDispatches({
        tenantId: c.tenant_id,
        campaignId: c.id,
        url: c.url,
        recipients: rows.map((r) => ({ subscriptionRowId: r.subscriptionRowId, playerId: r.playerId })),
      });

      const { appId: onesignalAppId, apiKey } = await deps.credentials(batch.appId);
      const idempotencyKey = await deterministicUuid(referenceId);
      const sendResult = await deps.send({
        tenantId: c.tenant_id,
        appId: onesignalAppId,
        apiKey,
        // Same order as `rows` (derived from the batch's own stored ids), so
        // the index-aligned mapping back to subscriptionRowId below holds.
        subscriptionIds: rows.map((r) => r.subscriptionId),
        title: c.title,
        body: c.body,
        url: campaignPushUrl(publicAppBaseUrl(), c.id),
        imageUrl: c.image_url,
        idempotencyKey,
      });

      if (!sendResult.ok) {
        if (sendResult.temporary) {
          // Leave the batch `pendente` WITH its reservation — never refund a
          // temporary failure. A retry re-reserves the same key (idempotent,
          // no double charge) and resends with the same OneSignal key.
          return { kind: "stop-temporary" };
        }
        // Permanent failure: refund once, every row of this batch refused.
        await deps.refund({
          tenantId: c.tenant_id,
          referenceId,
          idempotencyKey: `${referenceId}:refund`,
          reason: sendResult.error,
        });
        batch = await deps.updateBatch(batch.id, {
          status: "falhou",
          accepted: 0,
          refused_row_ids: batch.subscriptionRowIds,
          last_error: sendResult.error,
        });
        continue;
      }

      const invalidIds = new Set(sendResult.invalidSubscriptionIds);
      const refusedRowIds = rows
        .filter((r) => invalidIds.has(r.subscriptionId))
        .map((r) => r.subscriptionRowId);
      // Fix round 2 (ruling): `rows` already only holds subscriptions that
      // still exist (rowDetails selects by id — a row deleted via a
      // player/app cascade simply isn't in it). Deriving `accepted` from
      // `rows.length` — never from `batch.subscriptionRowIds.length`, the
      // ORIGINAL count at batch-creation time — means a since-deleted row
      // is never counted as accepted/charged; the settlement step (below,
      // `enviado` -> `liquidado`) already refunds+re-reserves for exactly
      // `accepted` whenever it's less than `units`, so this one change is
      // enough to keep the net charge correct without any other change here.
      const accepted = rows.length - refusedRowIds.length;
      batch = await deps.updateBatch(batch.id, {
        status: "enviado",
        accepted,
        refused_row_ids: refusedRowIds,
        onesignal_notification_id: sendResult.notificationId,
      });
      continue;
    }

    if (batch.status === "enviado") {
      const referenceId = batch.id;
      if (batch.accepted === batch.units) {
        batch = await deps.updateBatch(batch.id, { status: "liquidado" });
        continue;
      }
      // Partially (or not at all) accepted: refund the original reservation
      // once (idempotent on retry), then — if anything was accepted — a
      // FRESH reservation for just the accepted units, under its OWN
      // reference (`:ajuste`) so it never collides with the original.
      await deps.refund({
        tenantId: c.tenant_id,
        referenceId,
        idempotencyKey: `${referenceId}:refund`,
        reason: "OneSignal recusou parte do lote (invalid_player_ids)",
      });
      if ((batch.accepted ?? 0) > 0) {
        const adjustReferenceId = `${referenceId}:ajuste`;
        const adjustResult = await deps.reserve({
          tenantId: c.tenant_id,
          item: "webpush",
          units: batch.accepted!,
          referenceType: "webpush_campaign",
          referenceId: adjustReferenceId,
          idempotencyKey: adjustReferenceId,
        });
        if (!adjustResult.ok) {
          // Batch stays `enviado` (already refunded; not yet re-reserved):
          // the next tick retries settlement — refund is idempotent, so it
          // goes straight to this same adjustment reserve attempt.
          return { kind: "stop-insufficient-settlement" };
        }
      }
      batch = await deps.updateBatch(batch.id, { status: "liquidado" });
      continue;
    }

    if (batch.status === "liquidado" || batch.status === "falhou") {
      const refusedSet = new Set(batch.refusedRowIds ?? []);
      const rows = await deps.rowDetails(batch.subscriptionRowIds);
      const existingIds = new Set(rows.map((r) => r.subscriptionRowId));
      const playerOf = new Map(rows.map((r) => [r.subscriptionRowId, r.playerId]));

      // Fix round 2 (ruling): `webpush_send_logs.subscription_row_id`
      // references `push_subscriptions(id)` — a row deleted by a
      // player/app cascade while this batch was open can NEVER be
      // inserted there; attempting it would fail the same way on every
      // retry, permanently blocking the campaign behind this batch. Only
      // rows re-confirmed to still exist (`existingIds`, from a fresh
      // `rowDetails` call) are logged/marked/deactivated — a missing one
      // is silently dropped from every write below (it was already
      // excluded from `accepted` when the batch left `pendente`, so
      // nothing here double-counts or double-charges it).
      const loggableIds = batch.subscriptionRowIds.filter((id) => existingIds.has(id));

      const logs: WebpushLogRow[] = loggableIds.map((rowId) => ({
        campaignId: c.id,
        subscriptionRowId: rowId,
        playerId: playerOf.get(rowId) ?? null,
        appId: batch.appId,
        onesignalNotificationId: batch.onesignalNotificationId,
        status: refusedSet.has(rowId) ? "recusado" : "enviado",
        billingReference: refusedSet.has(rowId) ? null : batch.id,
      }));
      await deps.writeLogs(logs);

      await deps.markDispatches({
        tenantId: c.tenant_id,
        campaignId: c.id,
        sentIds: loggableIds.filter((id) => !refusedSet.has(id)),
        failedIds: loggableIds.filter((id) => refusedSet.has(id)),
        sentAt: deps.now(),
      });

      // Ruling correction (fix round 2): deactivation means "OneSignal says
      // this subscription isn't valid" (invalid_player_ids / not subscribed)
      // — that only ever comes from an ok:true send, i.e. a `liquidado`
      // batch. A `falhou` batch's rows are refused because the WHOLE call
      // failed for an unrelated reason (bad key, malformed request, ...),
      // which says nothing about the subscriptions themselves — never
      // deactivate them, only log/mark them `recusado`.
      const refusedExistingIds = loggableIds.filter((id) => refusedSet.has(id));
      if (batch.status === "liquidado" && refusedExistingIds.length > 0) {
        await deps.deactivate(refusedExistingIds);
      }

      await deps.updateBatch(batch.id, { status: "concluido" });
      return { kind: "concluded", accepted: batch.accepted ?? 0, refused: refusedSet.size };
    }

    // concluido: a resumed batch that had already finished (defensive; the
    // outer tick never re-fetches a batch it already saw as concluido).
    return { kind: "concluded", accepted: batch.accepted ?? 0, refused: (batch.refusedRowIds ?? []).length };
  }
}

async function returnWithTotals(
  campaignId: string,
  deps: WebpushDispatchDeps,
  status: string,
): Promise<WebpushCampaignTickResult> {
  const totals = await deps.concludedTotals(campaignId);
  return { status, sent: totals.sent, failed: totals.failed };
}

/**
 * Processes one claimed campaign for one tick. Resumes any open batch first
 * (`listOpenBatches`); only once none are open does it fetch a new page and,
 * if every one of its app-groups clears the burst guard and the rate budget,
 * persist a `pendente` batch for each group (all of the page's groups, or
 * none — a denial on any group aborts the page outright, nothing created,
 * nothing moved). Each batch is then driven to a terminal state by
 * `advanceBatch` on a later loop iteration, which may itself stop the tick
 * (temporary send failure, insufficient balance) — in which case the lock is
 * released and the campaign stays `enviando` (or becomes `pausada`), to be
 * resumed by the next scheduled tick. Hitting `opts.deadline` releases the
 * lock the same way (status `enviando`) instead of leaving it held until the
 * claim RPC's stale-lock reclaim.
 */
export async function processWebpushCampaignTick(
  campaignRow: WebpushCampaignRow,
  deps: WebpushDispatchDeps,
  opts: { deadline: number; batchSize?: number },
): Promise<WebpushCampaignTickResult> {
  const batchSize = opts.batchSize ?? 1000;
  let c = campaignRow;

  for (;;) {
    if (deps.now().getTime() >= opts.deadline) {
      await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
      return returnWithTotals(c.id, deps, "enviando");
    }

    const open = await deps.listOpenBatches(c.id);
    if (open.length > 0) {
      const outcome = await advanceBatch(open[0], c, deps);
      if (outcome.kind === "stop-temporary") {
        await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
        return returnWithTotals(c.id, deps, "enviando");
      }
      if (outcome.kind === "stop-insufficient-initial") {
        await deps.updateCampaign(c, {
          status: "pausada",
          last_error: WEBPUSH_CAMPAIGN_NO_BALANCE_MESSAGE,
          locked_at: null,
          locked_by: null,
          updated_at: deps.now().toISOString(),
        });
        return returnWithTotals(c.id, deps, "pausada");
      }
      if (outcome.kind === "stop-insufficient-settlement") {
        await deps.updateCampaign(c, {
          status: "pausada",
          last_error: WEBPUSH_SETTLEMENT_NO_BALANCE_MESSAGE,
          locked_at: null,
          locked_by: null,
          updated_at: deps.now().toISOString(),
        });
        return returnWithTotals(c.id, deps, "pausada");
      }
      // Concluded: loop again — `listOpenBatches` no longer returns it.
      continue;
    }

    // No open batches: every batch ever created for this campaign is
    // concluido, so it's safe to flush the cursor/counters now, before
    // fetching a new page (never past an un-batched row — see module header).
    const flush = await deps.concludedTotals(c.id);
    if (flush.maxRowId && flush.maxRowId !== c.sent_cursor) {
      const ok = await deps.updateCampaign(c, {
        sent_cursor: flush.maxRowId,
        sent_count: flush.sent,
        failed_count: flush.failed,
        locked_at: deps.now().toISOString(),
      });
      // Fix round 2 (lock-token guard regression): another worker re-claimed
      // this campaign (its lock no longer matches) — stop immediately,
      // before fetching a new page or creating any batch under a lock we no
      // longer hold. Mirrors the guard every other `updateCampaign` call
      // site already gets implicitly by returning right after its patch.
      if (!ok) return returnWithTotals(c.id, deps, "enviando");
      c = { ...c, sent_cursor: flush.maxRowId };
    }

    const page = await deps.nextBatch(c, c.sent_cursor ?? null, batchSize);
    if (page.length === 0) {
      const totals = await deps.concludedTotals(c.id);
      const finalStatus = totals.sent === 0 && totals.failed > 0 ? "falhou" : "enviado";
      await deps.updateCampaign(c, {
        status: finalStatus,
        sent_count: totals.sent,
        failed_count: totals.failed,
        locked_at: null,
        locked_by: null,
        updated_at: deps.now().toISOString(),
      });
      return { status: finalStatus, sent: totals.sent, failed: totals.failed };
    }

    const groups = groupByApp(page);

    // All-or-nothing admission: a denial on ANY group aborts the whole page
    // (no batch created for any group), so the page is retried in full on a
    // later tick — this is what keeps the cursor gap-free (ruling step 5).
    for (const group of groups) {
      const stats = await deps.appStats(group.appId);
      if (!canSendWithinBurstLimit(stats.sentLast15m, group.rows.length, stats.active)) {
        await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
        return returnWithTotals(c.id, deps, "enviando");
      }
    }
    for (const group of groups) {
      if (!(await deps.acquireBudget(c.tenant_id))) {
        await deps.updateCampaign(c, { status: "enviando", locked_at: null, locked_by: null });
        return returnWithTotals(c.id, deps, "enviando");
      }
    }

    for (const group of groups) {
      await deps.createBatch({
        tenantId: c.tenant_id,
        campaignId: c.id,
        appId: group.appId,
        subscriptionRowIds: group.rows.map((r) => r.subscriptionRowId),
        units: group.rows.length,
      });
    }
    // Loop back: the batches just created are now `open` and get driven to
    // a terminal state one at a time on the next iterations.
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

/**
 * Fix round 2: `refundUsage` (wallet.server.ts) deliberately swallows every
 * failure (RPC/transport error, or `wallet_refund` refusing for any other
 * reason) — fine for its other, fire-and-forget callers, but wrong here:
 * the state machine above relies on a refund either genuinely happening or
 * throwing, never silently doing nothing while the caller believes it
 * succeeded (that was letting a transient failure during settlement reach
 * `liquidado` — or a permanent send failure reach `falhou` — with the
 * original reservation never actually reversed: the house pays for units
 * it also re-reserved, or for a push that was never sent at all). Calls
 * `wallet_refund` directly: a transport/RPC error, or any refusal other
 * than "there is nothing left to refund" (`reservation_not_found`,
 * `already_refunded` — both meaning a previous attempt already finished
 * the job), throws so the batch stays exactly where it was and the next
 * resume retries this same refund.
 *
 * `db` is parameterized (rather than closing over `webpushDb` directly) so
 * this exact contract — throw vs. resolve per `wallet_refund`'s response —
 * is unit-testable without a real database
 * (campaign-dispatch.server.test.ts's "refundOrThrow" suite).
 */
export async function refundOrThrow(
  db: { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> },
  args: RefundUsageArgs,
): Promise<void> {
  const { data, error } = await db.rpc("wallet_refund", {
    _tenant: args.tenantId,
    _reference_id: args.referenceId,
    _idempotency_key: args.idempotencyKey,
    _reason: args.reason,
  });
  if (error) throw new Error(`wallet_refund falhou: ${error.message}`);
  const result = (data ?? {}) as { ok?: boolean; reason?: string };
  if (
    result.ok === false &&
    result.reason !== "reservation_not_found" &&
    result.reason !== "already_refunded"
  ) {
    throw new Error(`wallet_refund recusado: ${result.reason ?? "unknown"}`);
  }
}

function toDispatchBatch(row: Record<string, unknown>): WebpushDispatchBatch {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    campaignId: row.campaign_id as string,
    appId: row.app_id as string,
    subscriptionRowIds: (row.subscription_row_ids as string[]) ?? [],
    units: Number(row.units ?? 0),
    status: row.status as WebpushDispatchBatchStatus,
    accepted: row.accepted === null || row.accepted === undefined ? null : Number(row.accepted),
    refusedRowIds: (row.refused_row_ids as string[] | null) ?? null,
    onesignalNotificationId: (row.onesignal_notification_id as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
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
    acquireBudget: async (tenantId) => {
      const admission = await channelBudget.acquire(tenantId, "webpush", {
        deadline: Date.now() + WEBPUSH_CAMPAIGN_RUN_BUDGET_MS,
      });
      return admission.ok;
    },
    async createBatch(input) {
      const { data, error } = await webpushDb
        .from("webpush_dispatch_batches")
        .insert({
          tenant_id: input.tenantId,
          campaign_id: input.campaignId,
          app_id: input.appId,
          subscription_row_ids: input.subscriptionRowIds,
          units: input.units,
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return toDispatchBatch(data as Record<string, unknown>);
    },
    async listOpenBatches(campaignId) {
      const { data, error } = await webpushDb
        .from("webpush_dispatch_batches")
        .select("*")
        .eq("campaign_id", campaignId)
        .in("status", ["pendente", "enviado", "liquidado", "falhou"])
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map(toDispatchBatch);
    },
    async updateBatch(batchId, patch) {
      const { data, error } = await webpushDb
        .from("webpush_dispatch_batches")
        .update(patch)
        .eq("id", batchId)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return toDispatchBatch(data as Record<string, unknown>);
    },
    async rowDetails(subscriptionRowIds) {
      if (subscriptionRowIds.length === 0) return [];
      const { data, error } = await webpushDb
        .from("push_subscriptions")
        .select("id, subscription_id, player_id")
        .in("id", subscriptionRowIds);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ id: string; subscription_id: string; player_id: string | null }>).map(
        (r) => ({ subscriptionRowId: r.id, subscriptionId: r.subscription_id, playerId: r.player_id }),
      );
    },
    prepareDispatches: (args) => prepareWebpushDispatches(webpushDb, args),
    markDispatches: (args) => markWebpushDispatches(webpushDb, args),
    reserve: (args) => reserveUsage(webpushDb, args),
    refund: (args) => refundOrThrow(webpushDb, args),
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
    async concludedTotals(campaignId) {
      const { data, error } = await webpushDb
        .from("webpush_dispatch_batches")
        .select("subscription_row_ids, units, accepted")
        .eq("campaign_id", campaignId)
        .eq("status", "concluido");
      if (error) throw new Error(error.message);
      let maxRowId: string | null = null;
      let sent = 0;
      let failed = 0;
      for (const row of (data ?? []) as Array<{
        subscription_row_ids: string[];
        units: number;
        accepted: number | null;
      }>) {
        const accepted = row.accepted ?? 0;
        sent += accepted;
        failed += (row.units ?? 0) - accepted;
        for (const id of row.subscription_row_ids ?? []) {
          if (maxRowId === null || id > maxRowId) maxRowId = id;
        }
      }
      return { maxRowId, sent, failed };
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
 * one that hits the shared deadline (here, or inside
 * `processWebpushCampaignTick` itself) also has its lock released the same
 * way, so it never stalls until the stale-lock reclaim.
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
