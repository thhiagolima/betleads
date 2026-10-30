import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listDemoTenantIds } from "./tenant-access.server";
import { settleVoiceHistory, voiceCallAnswered } from "./voice-billing.server";

const MIN_AGE_MS = 15 * 60_000;
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const ALERT_AGE_MS = 24 * 60 * 60_000;

/** PostgREST list for `.not("tenant_id", "in", ...)`; null when there is no
 * demo tenant (no filter needed). Demo rows are never audited/rewritten. */
async function demoTenantFilter(demoTenantIds?: string[]): Promise<string | null> {
  const ids = demoTenantIds ?? (await listDemoTenantIds());
  return ids.length > 0 ? `(${ids.join(",")})` : null;
}

/**
 * Audits calls for which the CML post-call notification has not reached us.
 *
 * CML exposes `notifyUrl` as the post-call summary mechanism. This job is
 * deliberately not a second dispatcher and does not infer a final result: a
 * status is changed only by an Infobip callback. It leaves an auditable trail
 * and makes missing callbacks visible until a provider report integration is
 * explicitly enabled for the account.
 */
export async function reconcilePendingInfobipVoiceCalls(limit = 500, demoTenantIds?: string[]) {
  const now = Date.now();
  const demoFilter = await demoTenantFilter(demoTenantIds);
  let query = supabaseAdmin
    .from("call_history")
    .select("id, provider_call_id, created_at, provider_response")
    .eq("provider", "infobip")
    .in("status", ["pending", "answered"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString());
  if (demoFilter) query = query.not("tenant_id", "in", demoFilter);
  const { data: rows, error } = await query.order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;

  let alerted = 0;
  await Promise.all(
    (rows ?? []).map(async (row) => {
      const ageMs = now - new Date(row.created_at).getTime();
      const previous = row.provider_response && typeof row.provider_response === "object"
        ? row.provider_response as Record<string, unknown>
        : {};
      const existing = previous.reconciliation && typeof previous.reconciliation === "object"
        ? previous.reconciliation as Record<string, unknown>
        : {};
      const requiresAttention = ageMs >= ALERT_AGE_MS;
      if (requiresAttention) alerted += 1;
      const { error: updateError } = await supabaseAdmin
        .from("call_history")
        .update({
          provider_response: {
            ...previous,
            reconciliation: {
              ...existing,
              last_audited_at: new Date(now).toISOString(),
              callback_missing: true,
              requires_attention: requiresAttention,
            },
          } as never,
        })
        .eq("id", row.id)
        .in("status", ["pending", "answered"]);
      if (updateError) throw updateError;
    }),
  );

  if (alerted > 0) {
    console.warn("[infobip voice reconciliation] callbacks pendentes ha mais de 24h", { alerted });
  }
  return { audited: rows?.length ?? 0, alerted };
}

async function auditCallbackRows(
  rows: Array<{ id: string; created_at: string; provider_response: unknown }> | null,
  update: (
    id: string,
    response: Record<string, unknown>,
  ) => PromiseLike<{ error: unknown | null }>,
) {
  const now = Date.now();
  let alerted = 0;
  await Promise.all(
    (rows ?? []).map(async (row) => {
      const ageMs = now - new Date(row.created_at).getTime();
      const previous = row.provider_response && typeof row.provider_response === "object"
        ? row.provider_response as Record<string, unknown>
        : {};
      const existing = previous.reconciliation && typeof previous.reconciliation === "object"
        ? previous.reconciliation as Record<string, unknown>
        : {};
      const requiresAttention = ageMs >= ALERT_AGE_MS;
      if (requiresAttention) alerted += 1;
      const { error } = await update(row.id, {
        ...previous,
        reconciliation: {
          ...existing,
          last_audited_at: new Date(now).toISOString(),
          callback_missing: true,
          requires_attention: requiresAttention,
        },
      });
      if (error) throw error;
    }),
  );
  return { audited: rows?.length ?? 0, alerted };
}

/** Same daily safety net for Infobip Email callbacks. */
export async function reconcilePendingInfobipEmails(limit = 500, demoTenantIds?: string[]) {
  const now = Date.now();
  const demoFilter = await demoTenantFilter(demoTenantIds);
  let query = supabaseAdmin
    .from("email_send_logs")
    .select("id, created_at, provider_response")
    .in("status", ["pending", "sent"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString());
  if (demoFilter) query = query.not("tenant_id", "in", demoFilter);
  const { data: rows, error } = await query.order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  const result = await auditCallbackRows(rows, (id, providerResponse) =>
    supabaseAdmin
      .from("email_send_logs")
      .update({ provider_response: providerResponse as never })
      .eq("id", id)
      .in("status", ["pending", "sent"]),
  );
  if (result.alerted) console.warn("[infobip email reconciliation] callbacks pendentes ha mais de 24h", result);
  return result;
}

/**
 * SMS is also callback-first; this exposes missing delivery callbacks of both
 * SMS providers (Short Brasil and Infobip accounts).
 */
export async function reconcilePendingShortBrasilSms(limit = 500, demoTenantIds?: string[]) {
  const now = Date.now();
  const demoFilter = await demoTenantFilter(demoTenantIds);
  let query = supabaseAdmin
    .from("sms_send_logs")
    .select("id, created_at, provider_response")
    .in("provider", ["short-brasil", "infobip"])
    .in("delivery_status", ["pending", "sent"])
    .lte("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gte("created_at", new Date(now - MAX_AGE_MS).toISOString());
  if (demoFilter) query = query.not("tenant_id", "in", demoFilter);
  const { data: rows, error } = await query.order("created_at", { ascending: true }).limit(limit);
  if (error) throw error;
  const result = await auditCallbackRows(rows, (id, providerResponse) =>
    supabaseAdmin
      .from("sms_send_logs")
      .update({ provider_response: providerResponse as never })
      .eq("id", id)
      .in("delivery_status", ["pending", "sent"]),
  );
  if (result.alerted) console.warn("[short brasil sms reconciliation] callbacks pendentes ha mais de 24h", result);
  return result;
}

// --- PG3 Task 5: settle voice reservations without a final event ----------

/** A reservation is settled here only after the provider had 24 h to report. */
const VOICE_SETTLE_AFTER_MS = 24 * 60 * 60_000;
/**
 * Final fix I2: a call still 'pending' with no `cml_answered` callback after
 * this long was never picked up (a call lasts at most a few minutes), so its
 * hold is released as unanswered instead of waiting the full 24 h.
 */
const VOICE_UNANSWERED_SETTLE_AFTER_MS = 60 * 60_000;
/**
 * How far back the daily job looks. Wider than one day so a few missed runs
 * still settle everything; bounded so the scan never reads the whole ledger.
 */
const VOICE_SETTLE_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const VOICE_SETTLE_PAGE_SIZE = 500;
/** Ids/references per `.in()` filter, to keep the PostgREST URL short. */
const IN_CHUNK = 100;
/** Upper bound on pages per run (500 * 200 = 100k reservations). */
const VOICE_SETTLE_MAX_PAGES = 200;

type StaleReservation = {
  id: string;
  tenant_id: string;
  reference_id: string | null;
  created_at: string;
};
type BillingHistoryRow = {
  id: string;
  tenant_id: string;
  billing_reference_id: string | null;
  status: string | null;
  result?: string | null;
  duration_seconds: number | null;
  provider_response: unknown;
  created_at: string;
};

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * How a reservation without a final event is settled (spec decision 4):
 *   * no call_history row (its insert failed): unanswered;
 *   * 'pending': the CML was never fetched, so nobody answered: unanswered;
 *   * 'answered': the CML was fetched, the duration is unknown: keep the cap;
 *   * any other status: the final event WAS processed but its settlement
 *     failed; use what it recorded (answered per voiceCallAnswered or a
 *     completed result with a positive duration; null duration keeps the cap).
 */
function staleSettlement(row: BillingHistoryRow | undefined): {
  answered: boolean;
  durationSeconds: number | null;
} {
  if (!row) return { answered: false, durationSeconds: null };
  if (row.status === "pending" || row.status === "answered") {
    // A 'pending' row that somehow carries a cml_answered callback was
    // picked up: it keeps the cap like an 'answered' one.
    return { answered: voiceCallAnswered(row), durationSeconds: null };
  }
  // Same rule as the final event (events.ts, fix round 1): the CML record or
  // a completed call with a positive duration.
  const completedWithDuration =
    row.result === "completed" && row.duration_seconds != null && row.duration_seconds > 0;
  return {
    answered: voiceCallAnswered(row) || completedWithDuration,
    durationSeconds: row.duration_seconds ?? null,
  };
}

/**
 * True when the reservation is due for settlement without a final event:
 * a call_history row still 'pending' with no `cml_answered` callback after
 * 60 minutes (nobody picked up); anything else (answered, a processed final
 * event, or no history row at all) after 24 h.
 */
function settlementDue(
  reservation: StaleReservation,
  row: BillingHistoryRow | undefined,
  now: number,
): boolean {
  const ageMs = now - new Date(reservation.created_at).getTime();
  if (ageMs >= VOICE_SETTLE_AFTER_MS) return true;
  return (
    row !== undefined &&
    row.status === "pending" &&
    !voiceCallAnswered(row) &&
    ageMs >= VOICE_UNANSWERED_SETTLE_AFTER_MS
  );
}

/**
 * Settles every `voice_call` reservation that has no reversing usage_refund
 * (no settlement and no refund yet) and is due (`settlementDue`: 60 min for
 * a never-answered pending call, 24 h otherwise). Keyed by the ledger, not
 * by call_history, so a call whose history insert failed is still settled.
 * The settlement key is the one the final event uses, so a late event after
 * this only replays the stored result. Runs hourly from the billing cycle
 * and daily from the callback reconciliation.
 */
export async function settleStaleVoiceReservations(
  demoTenantIds?: string[],
  options: { pageSize?: number } = {},
) {
  const now = Date.now();
  const pageSize = options.pageSize ?? VOICE_SETTLE_PAGE_SIZE;
  const demoFilter = await demoTenantFilter(demoTenantIds);
  const counts = { checked: 0, settled: 0, skipped: 0, failed: 0 };

  for (let page = 0; page < VOICE_SETTLE_MAX_PAGES; page++) {
    let query = supabaseAdmin
      .from("wallet_ledger")
      .select("id, tenant_id, reference_id, created_at")
      .eq("entry_type", "usage_reservation")
      .eq("reference_type", "voice_call")
      .lte("created_at", new Date(now - VOICE_UNANSWERED_SETTLE_AFTER_MS).toISOString())
      .gte("created_at", new Date(now - VOICE_SETTLE_LOOKBACK_MS).toISOString());
    if (demoFilter) query = query.not("tenant_id", "in", demoFilter);
    // Offset pagination is stable here: settling adds refund rows but never
    // removes or reorders the reservations this query reads.
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    const reservations = (data ?? []) as StaleReservation[];
    if (reservations.length === 0) break;

    const reversed = new Set<string>();
    for (const ids of chunks(reservations.map((r) => r.id), IN_CHUNK)) {
      const { data: refunds, error: refundError } = await supabaseAdmin
        .from("wallet_ledger")
        .select("reverses_ledger_id")
        .eq("entry_type", "usage_refund")
        .in("reverses_ledger_id", ids);
      if (refundError) throw refundError;
      for (const refund of refunds ?? []) {
        if (refund.reverses_ledger_id) reversed.add(refund.reverses_ledger_id);
      }
    }
    const open = reservations.filter((r) => !reversed.has(r.id) && r.reference_id);

    const historyByKey = new Map<string, BillingHistoryRow>();
    const refs = [...new Set(open.map((r) => r.reference_id as string))];
    for (const chunk of chunks(refs, IN_CHUNK)) {
      const { data: rows, error: historyError } = await supabaseAdmin
        .from("call_history")
        .select("id, tenant_id, billing_reference_id, status, result, duration_seconds, provider_response, created_at")
        .in("billing_reference_id", chunk);
      if (historyError) throw historyError;
      for (const row of (rows ?? []) as BillingHistoryRow[]) {
        const key = `${row.tenant_id}|${row.billing_reference_id}`;
        const current = historyByKey.get(key);
        // One row per reference is the norm; on duplicates keep the latest.
        if (!current || row.created_at > current.created_at) historyByKey.set(key, row);
      }
    }

    for (const reservation of open) {
      const referenceId = reservation.reference_id as string;
      const row = historyByKey.get(`${reservation.tenant_id}|${referenceId}`);
      if (!settlementDue(reservation, row, now)) continue;
      counts.checked += 1;
      const result = await settleVoiceHistory({
        tenantId: reservation.tenant_id,
        referenceId,
        historyId: row?.id ?? null,
        ...staleSettlement(row),
      });
      if (!result) counts.failed += 1;
      else if (result.ok) counts.settled += 1;
      else counts.skipped += 1;
    }

    if (reservations.length < pageSize) break;
  }

  if (counts.checked > 0) {
    console.warn("[infobip voice reconciliation] reservas de voz liquidadas sem evento final", counts);
  }
  return counts;
}

export async function reconcileChannelCallbacks() {
  const demoTenantIds = await listDemoTenantIds();
  // The audits only touch provider_response; the settle moves money. A
  // failed audit must never hold the settle back (final fix, minor 5), so
  // both run to completion and the first error is rethrown afterwards.
  const [audits, settle] = await Promise.allSettled([
    Promise.all([
      reconcilePendingInfobipVoiceCalls(500, demoTenantIds),
      reconcilePendingInfobipEmails(500, demoTenantIds),
      reconcilePendingShortBrasilSms(500, demoTenantIds),
    ]),
    settleStaleVoiceReservations(demoTenantIds),
  ]);
  if (settle.status === "rejected") {
    console.error("[infobip voice reconciliation] falha ao liquidar reservas de voz", settle.reason);
  }
  if (audits.status === "rejected") throw audits.reason;
  if (settle.status === "rejected") throw settle.reason;
  const [voice, email, sms] = audits.value;
  return { voice, email, sms, voiceBilling: settle.value };
}
