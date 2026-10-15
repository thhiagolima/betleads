// ENV-06/ENV-07 — one tick of a claimed SMS campaign.
//
// Free of module-level I/O: every side effect goes through `CampaignDispatchDeps`
// (wired to Supabase/sendSmsInternal in sms-dispatcher.server.ts), so the
// throughput, dedupe and cursor rules are unit-tested without a database.
import {
  campaignBatchSize,
  campaignConcurrency,
  campaignDeliveryKey,
  campaignTickQuota,
  isUnresolvedReason,
  SMS_CAMPAIGN_DEFAULT_RATE,
  SMS_CAMPAIGN_TICK_SECONDS,
  type RecipientResolution,
  type UnresolvedReason,
  type UnresolvedRecipient,
} from "./campaign-recipients";

export type SmsCampaignRow = {
  id: string;
  tenant_id: string;
  name: string;
  content: string;
  route: string;
  recipients: unknown;
  total_count: number;
  sent_count: number;
  deduplicated_count: number;
  failed_count: number;
  scheduled_at: string;
  sent_cursor: number;
  last_error: string | null;
  rate_per_minute: number | null;
  track_links?: boolean | null;
  locked_by?: string | null;
  unresolved_count?: number | null;
};

export type CampaignTarget = {
  phone: string;
  playerId: string | null;
  /** Set once the recipient was classified as not sendable; it is skipped forever. */
  unresolvedReason?: UnresolvedReason | null;
};

export function parseCampaignTargets(raw: unknown): CampaignTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignTarget[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || typeof (r as { phone?: unknown }).phone !== "string")
      continue;
    const pid = (r as { playerId?: unknown }).playerId;
    const reason = (r as { unresolvedReason?: unknown }).unresolvedReason;
    out.push({
      phone: (r as { phone: string }).phone,
      playerId: typeof pid === "string" && pid ? pid : null,
      ...(isUnresolvedReason(reason) ? { unresolvedReason: reason } : {}),
    });
  }
  return out;
}

export type SendOutcome = {
  ok: boolean;
  /** sendSmsInternal found an accepted log for the same delivery key. */
  alreadySent?: boolean;
  /** ENV-10: possibly sent (timeout after the request left); counted as sent, never resent. */
  pendingConfirmation?: boolean;
  /** ENV-10: nothing reached the provider and resending later is safe. */
  retryable?: boolean;
  /** The provider refused the ACCOUNT (101/505, 401/402/403): retryable, never the lead's fault. */
  providerAccount?: boolean;
  error?: string;
};

/**
 * SMS provider circuit breaker, asked before every batch:
 *   closed -> normal batch; open -> the tick stops before the batch
 *   (stop_reason provider_unavailable, cursor untouched); probe -> a batch of
 *   ONE recipient (the half-open probe).
 */
export type ProviderGateDecision =
  | { mode: "closed" }
  | { mode: "probe" }
  | { mode: "open"; message: string };

export type CampaignSendItem = {
  target: CampaignTarget & { playerId: string };
  deliveryKey: string;
  variables: Record<string, string> | null;
};

export type ContactDecision = { allowed: boolean; retryAt: string | null };

export type CampaignDispatchDeps = {
  now: () => number;
  resolveRecipients: (
    tenantId: string,
    inputs: CampaignTarget[],
  ) => Promise<RecipientResolution>;
  /** Writes guarded by the campaign lock; false = lock lost / write failed (stop). */
  updateCampaign: (campaign: SmsCampaignRow, patch: Record<string, unknown>) => Promise<boolean>;
  persistUnresolved: (campaignId: string, unresolved: UnresolvedRecipient[]) => Promise<void>;
  /** Rate-limit integration point: returns how many sends may happen now (0..want). */
  acquireSendBudget: (tenantId: string, want: number) => Promise<number>;
  checkContactLimits: (
    tenantId: string,
    playerIds: string[],
  ) => Promise<Map<string, ContactDecision>>;
  findAcceptedDeliveryKeys: (keys: string[]) => Promise<Set<string>>;
  loadPlayerVariables: (playerIds: string[]) => Promise<Map<string, Record<string, string>>>;
  send: (args: {
    campaign: SmsCampaignRow;
    target: CampaignTarget & { playerId: string };
    deliveryKey: string;
    variables: Record<string, string> | null;
  }) => Promise<SendOutcome>;
  /**
   * ENV-10: sends the whole batch in one provider call per chunk (Short Brasil
   * bulk). Returns one outcome per item, in order. Throwing means nothing was
   * sent or charged: the batch is retried in a later tick (cursor not moved).
   * When absent, `send` is called per recipient.
   */
  sendBatch?: (args: { campaign: SmsCampaignRow; items: CampaignSendItem[] }) => Promise<SendOutcome[]>;
  /** SMS provider breaker; absent = always closed. */
  providerGate?: () => Promise<ProviderGateDecision>;
};

export type CampaignTickResult = {
  sent: number;
  deduplicated: number;
  failed: number;
  /** Recipients the cursor moved past in this tick (sendable + skipped). */
  advanced: number;
  status: "enviado" | "enviando" | "falhou";
  stopReason:
    | "done"
    | "quota"
    | "deadline"
    | "budget"
    | "contact_limit"
    | "lock_lost"
    | "resolution_error"
    | "no_recipients"
    | "none_resolved"
    | "provider_unavailable";
  /** ENV-10: sends whose provider outcome is unknown (counted in `sent`). */
  pendingConfirmation?: number;
};

/** Consecutive empty budget grants (each after acquireSendBudget's own wait) before the tick stops. */
export const MAX_ZERO_GRANTS = 3;

type BatchItem =
  | { kind: "skip"; target: CampaignTarget }
  | { kind: "dup"; target: CampaignTarget; key: string }
  | { kind: "send"; target: CampaignTarget & { playerId: string }; key: string };

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

function unresolvedOf(targets: CampaignTarget[]): UnresolvedRecipient[] {
  const seen = new Set<string>();
  const out: UnresolvedRecipient[] = [];
  for (const t of targets) {
    if (!t.unresolvedReason) continue;
    const key = `${t.unresolvedReason}|${t.phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phone: t.phone, reason: t.unresolvedReason });
  }
  return out;
}

/**
 * Processes one claimed campaign for one tick:
 * 1. resolves legacy phone-only recipients (unresolved ones are skipped and
 *    reported, never block the campaign; it fails only if none resolves);
 * 2. sends up to `rate_per_minute × tick` recipients within the run deadline,
 *    in batches; each send carries a stable (campaign, player) delivery key;
 * 3. persists the cursor and counters AFTER each batch was sent.
 */
export async function processSmsCampaignTick(
  c: SmsCampaignRow,
  deps: CampaignDispatchDeps,
  opts: { deadline: number; tickSeconds?: number },
): Promise<CampaignTickResult> {
  const result: CampaignTickResult = {
    sent: 0,
    deduplicated: 0,
    failed: 0,
    advanced: 0,
    status: "enviando",
    stopReason: "done",
  };
  const targets = parseCampaignTargets(c.recipients);
  if (targets.length === 0) {
    await deps.updateCampaign(c, {
      status: "falhou",
      last_error: "Sem destinatários",
      locked_at: null,
      locked_by: null,
    });
    return { ...result, status: "falhou", stopReason: "no_recipients" };
  }

  // 1. Dispatch-time resolution for campaigns that stored only phones.
  const pendingIdx = targets
    .map((t, i) => (!t.playerId && !t.unresolvedReason ? i : -1))
    .filter((i) => i >= 0);
  if (pendingIdx.length > 0) {
    let resolution: RecipientResolution;
    try {
      resolution = await deps.resolveRecipients(
        c.tenant_id,
        pendingIdx.map((i) => targets[i]),
      );
    } catch (error) {
      await deps.updateCampaign(c, {
        status: "enviando",
        last_error: `Falha ao resolver destinatários: ${error instanceof Error ? error.message : String(error)}`,
        locked_at: null,
        locked_by: null,
      });
      return { ...result, stopReason: "resolution_error" };
    }
    pendingIdx.forEach((targetIdx, k) => {
      const a = resolution.assignments[k];
      if (!a) return;
      targets[targetIdx] = a.playerId
        ? { phone: a.phone, playerId: a.playerId }
        : { phone: a.phone, playerId: null, unresolvedReason: a.reason };
    });
    const resolvedTotal = targets.filter((t) => t.playerId).length;
    const ok = await deps.updateCampaign(c, {
      recipients: targets,
      total_count: resolvedTotal,
    });
    if (!ok) return { ...result, stopReason: "lock_lost" };
    c = { ...c, total_count: resolvedTotal, recipients: targets };
    await deps.persistUnresolved(c.id, unresolvedOf(targets));
  }

  const sendable = targets.filter((t) => t.playerId).length;
  if (sendable === 0) {
    const unresolved = unresolvedOf(targets).length;
    await deps.updateCampaign(c, {
      status: "falhou",
      last_error: `Nenhum destinatário corresponde a um jogador cadastrado (${unresolved} não enviado(s)). Veja o relatório da campanha.`,
      locked_at: null,
      locked_by: null,
    });
    return { ...result, status: "falhou", stopReason: "none_resolved" };
  }

  // 2. Send loop.
  const rate = Math.max(1, c.rate_per_minute ?? SMS_CAMPAIGN_DEFAULT_RATE);
  const quota = campaignTickQuota(rate, opts.tickSeconds ?? SMS_CAMPAIGN_TICK_SECONDS);
  const concurrency = campaignConcurrency(rate);
  const trigger = `campanha:${c.name}:${c.route}`;
  let cursor = Math.max(0, c.sent_cursor ?? 0);
  let processedSendable = 0;
  let lastError: string | null = null;
  let retryAt: string | null = null;
  let lastBatchMs = 0;
  const seenKeys = new Set<string>();
  let stop: CampaignTickResult["stopReason"] | null = null;
  let zeroGrants = 0;

  while (cursor < targets.length) {
    if (processedSendable >= quota) {
      stop = "quota";
      break;
    }
    if (deps.now() + lastBatchMs >= opts.deadline) {
      stop = "deadline";
      break;
    }
    const batchStartedAt = deps.now();
    const gate: ProviderGateDecision = deps.providerGate
      ? await deps.providerGate()
      : { mode: "closed" };
    if (gate.mode === "open") {
      // Provider refuses the account: nothing is sent, the cursor stays.
      lastError = gate.message;
      stop = "provider_unavailable";
      break;
    }
    const want =
      gate.mode === "probe" ? 1 : campaignBatchSize(concurrency, quota - processedSendable);

    // Collect the next window in cursor order: skipped (unresolved) entries are
    // free; sendable ones count towards the batch size.
    const items: BatchItem[] = [];
    let sendableInWindow = 0;
    for (let i = cursor; i < targets.length && sendableInWindow < want; i++) {
      const t = targets[i];
      if (!t.playerId) {
        items.push({ kind: "skip", target: t });
        continue;
      }
      const key = await campaignDeliveryKey(c.id, t.playerId);
      items.push({ kind: "send", target: t as CampaignTarget & { playerId: string }, key });
      sendableInWindow++;
    }

    // Dedupe by (campaign, player): already accepted in a previous run/crash, or
    // the same player listed twice. Checked before the contact limit so a
    // re-processed batch never stalls on the message it already delivered.
    const keysToCheck = items
      .filter((it): it is Extract<BatchItem, { kind: "send" }> => it.kind === "send")
      .map((it) => it.key)
      .filter((k) => !seenKeys.has(k));
    const accepted = keysToCheck.length ? await deps.findAcceptedDeliveryKeys(keysToCheck) : new Set<string>();
    // seenKeys only learns keys of items that were actually processed (below):
    // a recipient cut off by the budget is sent in the next round, not
    // mistaken for a duplicate.
    const windowKeys = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "send") continue;
      if (seenKeys.has(it.key) || accepted.has(it.key) || windowKeys.has(it.key)) {
        items[i] = { kind: "dup", target: it.target, key: it.key };
      }
      windowKeys.add(it.key);
    }

    // Contact frequency, checked for the whole batch at once. The cursor keeps
    // its order: the batch is cut before the first limited recipient, who is
    // retried later instead of being skipped.
    const toCheck = Array.from(
      new Set(
        items
          .filter((it): it is Extract<BatchItem, { kind: "send" }> => it.kind === "send")
          .map((it) => it.target.playerId),
      ),
    );
    const decisions = toCheck.length
      ? await deps.checkContactLimits(c.tenant_id, toCheck)
      : new Map<string, ContactDecision>();
    let cut = items.length;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "send") continue;
      const decision = decisions.get(it.target.playerId);
      if (decision && !decision.allowed) {
        cut = i;
        retryAt = decision.retryAt;
        stop = "contact_limit";
        break;
      }
    }
    let batch = items.slice(0, cut);

    // Provider/tenant budget for the sends actually going out. A partial grant
    // does NOT end the tick (I1): the granted part is sent and the loop asks
    // again (acquireSendBudget waits briefly for refills, so the loop paces
    // itself at the bucket rate) until the deadline or the quota. Only
    // MAX_ZERO_GRANTS empty grants in a row (channel paused/contended) stop it.
    const sendCount = batch.filter((it) => it.kind === "send").length;
    if (sendCount > 0) {
      const granted = Math.max(0, Math.min(sendCount, await deps.acquireSendBudget(c.tenant_id, sendCount)));
      if (granted < sendCount) {
        let seen = 0;
        let end = batch.length;
        for (let i = 0; i < batch.length; i++) {
          if (batch[i].kind !== "send") continue;
          if (seen === granted) {
            end = i;
            break;
          }
          seen++;
        }
        batch = batch.slice(0, end);
        // The contact-limited recipient (if any) lies beyond the cut: it is
        // re-evaluated when the loop gets there.
        if (stop === "contact_limit") {
          stop = null;
          retryAt = null;
        }
        if (granted === 0 && ++zeroGrants >= MAX_ZERO_GRANTS) stop = "budget";
      }
      if (granted > 0) zeroGrants = 0;
    }
    if (batch.length === 0) {
      if (stop) break;
      continue;
    }
    for (const it of batch) if (it.kind !== "skip") seenKeys.add(it.key);

    const sends = batch.filter(
      (it): it is Extract<BatchItem, { kind: "send" }> => it.kind === "send",
    );
    const vars = sends.length
      ? await deps.loadPlayerVariables(Array.from(new Set(sends.map((s) => s.target.playerId))))
      : new Map<string, Record<string, string>>();
    let outcomes: SendOutcome[];
    let deferredError: string | null = null;
    if (deps.sendBatch && sends.length > 0) {
      try {
        outcomes = await deps.sendBatch({
          campaign: c,
          items: sends.map((it) => ({
            target: it.target,
            deliveryKey: it.key,
            variables: vars.get(it.target.playerId) ?? null,
          })),
        });
      } catch (error) {
        outcomes = [];
        deferredError = error instanceof Error ? error.message : String(error);
      }
    } else {
      outcomes = await runPool(sends, concurrency, async (it) => {
        try {
          return await deps.send({
            campaign: c,
            target: it.target,
            deliveryKey: it.key,
            variables: vars.get(it.target.playerId) ?? null,
          });
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
    // QA I1: a retryable failure (nothing reached the provider: connection
    // refused, no credentials, 101/505, write-ahead failure of a later chunk)
    // must not be burnt by the cursor. The batch is cut at the FIRST retryable
    // recipient (cursor order preserved): everything before it is counted and
    // checkpointed; from it onwards is re-processed next tick (accepted items
    // after the cut are deduped by their delivery key, never resent).
    const firstRetryable = deferredError !== null ? 0 : outcomes.findIndex((o) => !o?.ok && o?.retryable);
    if (firstRetryable >= 0) {
      lastError =
        deferredError ?? outcomes[firstRetryable]?.error ?? "Provedor SMS indisponível";
      stop = "provider_unavailable";
      const cutKey = sends[firstRetryable]?.key;
      const cutAt = batch.findIndex((it) => it.kind === "send" && it.key === cutKey);
      batch = cutAt >= 0 ? batch.slice(0, cutAt) : [];
      outcomes = outcomes.slice(0, firstRetryable);
      if (batch.length === 0) break;
    }
    let batchSent = 0;
    let batchDedup = batch.filter((it) => it.kind === "dup").length;
    let batchFailed = 0;
    for (const o of outcomes) {
      if (o?.ok && o.alreadySent) batchDedup++;
      else if (o?.ok) {
        batchSent++;
        if (o.pendingConfirmation) {
          result.pendingConfirmation = (result.pendingConfirmation ?? 0) + 1;
          lastError = `SMS aguardando confirmação do provedor: ${o.error ?? "sem resposta"}`;
        }
      } else {
        batchFailed++;
        if (o?.error) lastError = o.error;
      }
    }
    result.sent += batchSent;
    result.deduplicated += batchDedup;
    result.failed += batchFailed;
    processedSendable += batch.filter((it) => it.kind !== "skip").length;

    // 3. Cursor only moves after the batch was sent and logged.
    cursor += batch.length;
    result.advanced += batch.length;
    const ok = await deps.updateCampaign(c, {
      sent_cursor: cursor,
      sent_count: (c.sent_count ?? 0) + result.sent,
      deduplicated_count: (c.deduplicated_count ?? 0) + result.deduplicated,
      failed_count: (c.failed_count ?? 0) + result.failed,
      last_error: lastError ?? c.last_error ?? null,
      locked_at: new Date(deps.now()).toISOString(),
    });
    if (!ok) return { ...result, stopReason: "lock_lost" };
    lastBatchMs = deps.now() - batchStartedAt;
    if (stop) break;
  }

  const isDone = cursor >= targets.length;
  const totalSent = (c.sent_count ?? 0) + result.sent;
  const totalDedup = (c.deduplicated_count ?? 0) + result.deduplicated;
  result.status = isDone ? (totalSent + totalDedup === 0 ? "falhou" : "enviado") : "enviando";
  result.stopReason = isDone ? "done" : (stop ?? "quota");
  const patch: Record<string, unknown> = {
    status: result.status,
    locked_at: null,
    locked_by: null,
  };
  if (!isDone && result.stopReason === "contact_limit") {
    patch.scheduled_at = retryAt ?? new Date(deps.now() + 3600_000).toISOString();
  }
  if (result.stopReason === "provider_unavailable") patch.last_error = lastError;
  await deps.updateCampaign(c, patch);
  return result;
}
