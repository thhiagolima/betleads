// ENV-10 — Envio em lote (Short Brasil /bot/bulk-sms.php).
//
// sendSmsBatch(items) sends N personalised SMS (each with its own rendered text
// and its own tracked links) in one HTTP call per chunk of <= 500 items,
// instead of one call per recipient. Per item it keeps every guarantee of the
// single path (sendSmsInternal):
//   * idempotency: parceiroId = sms_send_logs.idempotency_key = deliveryKey, so
//     a delivery already accepted is never sent again and callbacks (GET single
//     or POST { lote: [...] }) match the row by provider id or parceiroId;
//   * billing: one credit per item under `delivery:<key>[:generation]`; an item
//     the provider did not accept is refunded; a retry never charges twice;
//   * consent and tenant status are checked before anything is charged;
//   * link tracking: one dispatch per recipient/URL (prepareTrackedTextBatch).
//
// Write-ahead log. The log rows are inserted BEFORE the provider call with
// status 'sent' + delivery_status 'submitting', so the delivery key already
// counts as accepted (ACCEPTED_SMS_STATUSES). A crash or timeout after the
// request therefore never leads to a second send of up to 500 messages
// (the provider does not dedupe by parceiroId). After the response:
//   accepted (in response bulk[])  -> delivery_status 'sent', provider id stored
//   missing from bulk[] / rejected -> status 'error', delivery_status 'failed', refund
//   outcome_unknown (timeout/reset after the body left, 5xx, unparseable 2xx)
//                                  -> kept as accepted with delivery_status
//                                     'unconfirmed'; never retried; the callback
//                                     confirms or fails it
//   not_sent / misconfigured / request-level rejection (101, 303, 505, 4xx)
//                                  -> whole chunk 'error' + refund; `retryable`
//                                     tells the caller whether resending later
//                                     is safe
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { assertTenantCanOperate, assertTenantNotDemoForSend } from "./tenant-access.server";
import { isDemoBlockedError } from "./demo-tenant";
import { captureServerException } from "./observability/sentry.server";
import { normalizeConsentSubject } from "./consent.server";
import { requireBrazilianPhone } from "./phone-normalization";
import {
  smsProviderAccountReason,
  transportErrorKind,
  type ProviderErrorKind,
} from "./rate-limit/transport-errors";
import {
  noteSmsProviderSuccess,
  reportSmsProviderAccountFailure,
} from "./sms-provider-breaker.server";
import { findAcceptedDeliveryKeys, type CampaignDb } from "./campaign-recipients.server";
import {
  markTrackedDispatchesFailed,
  markTrackedDispatchesSent,
  prepareTrackedTextBatch,
  type LinkTrackingContext,
} from "./shortio.server";
import {
  getShortBrasilAppStatus,
  refundSmsCredit,
  reserveSmsCreditForDelivery,
  sendSmsInternal,
  shortBrasilBulkUrl,
  shortBrasilCredentials,
  shortcodeToken,
  summarizeProviderError,
  toShortBrasilCell,
} from "./sms.functions";

/** Items per HTTP request. The provider accepts 5000; 500 limits the blast radius. */
export const SMS_BULK_CHUNK_SIZE = 500;
export const SMS_BULK_REQUEST_TIMEOUT_MS = 30_000;
const NOT_SENT_MAX_ATTEMPTS = 3;
const CREDIT_CONCURRENCY = 10;
const DB_CHUNK = 200;

export type SmsBatchItem = {
  tenantId: string;
  to: string;
  /** Final text: template variables already applied. Links are rewritten here. */
  content: string;
  /** Stable identity of the delivery; also the provider parceiroId. */
  deliveryKey: string;
  playerId: string | null;
  triggerName?: string | null;
  linkTrackingEnabled?: boolean;
  linkTrackingOrigin?: Pick<
    LinkTrackingContext,
    | "sourceType"
    | "sourceId"
    | "journeyStepId"
    | "journeyStepPosition"
    | "shortDomainId"
    | "recipientHash"
  >;
};

export type SmsBatchStatus =
  /** Provider returned the item in bulk[] with a message id. */
  | "accepted"
  /** Request may have been processed (timeout/reset/5xx). Counts as sent; never resent. */
  | "pending_confirmation"
  /** A previous run already has an accepted log for this deliveryKey. */
  | "already_sent"
  /** Provider answered but did not accept this item. */
  | "rejected"
  /** Not sent (validation, consent, credits, link tracking, transport, credentials). */
  | "failed";

export type SmsBatchOutcome = {
  deliveryKey: string;
  status: SmsBatchStatus;
  /** accepted | pending_confirmation | already_sent */
  ok: boolean;
  /** Nothing reached the provider and a later resend is safe and may succeed. */
  retryable: boolean;
  error?: string;
  errorKind?: ProviderErrorKind | null;
  providerMessageId?: string | null;
  logId?: string | null;
  suppressed?: boolean;
  insufficientFunds?: boolean;
};

export type SmsBatchResult = {
  outcomes: SmsBatchOutcome[];
  /** Provider batch ids (`id` of each bulk response). */
  lotes: string[];
  httpCalls: number;
};

/**
 * Feature flag (QA B1): bulk sending is OFF unless SMS_BULK_ENABLED is exactly
 * "true". With it off, campaigns keep the per-recipient path after deploy.
 */
export function smsBulkEnabled(): boolean {
  return (process.env.SMS_BULK_ENABLED ?? "").trim().toLowerCase() === "true";
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

/** Short Brasil bulk needs the legacy usuario/chave; the Bearer API stays on the single path. */
export function smsBulkTransport(): "short-brasil-bulk" | "single" | "misconfigured" {
  if (shortcodeToken()) return "single";
  const { usuario, chave } = shortBrasilCredentials();
  return usuario && chave ? "short-brasil-bulk" : "misconfigured";
}

type Prepared = {
  index: number;
  item: SmsBatchItem;
  phone: string;
  cell: string;
  logId: string;
  content: string;
  dispatchIds: string[];
  billingReferenceId: string | null;
};

type LogRow = {
  id: string;
  to_phone: string;
  content: string;
  status: "sent" | "error";
  provider: "short-brasil";
  provider_response: Json;
  error: string | null;
  idempotency_key: string | null;
  provider_message_id: string | null;
  delivery_status: string;
  player_id: string | null;
  trigger_name: string | null;
  tenant_id: string;
};

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function chunked<T>(items: T[], size: number, fn: (part: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

async function runLimited<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function logRow(p: Omit<LogRow, "provider">): LogRow {
  return { ...p, provider: "short-brasil" };
}

async function insertLogs(rows: LogRow[]) {
  await chunked(rows, 500, async (part) => {
    const { error } = await db().from("sms_send_logs").insert(part);
    if (error) throw new Error(`Falha ao registrar envio SMS em lote: ${error.message}`);
  });
}

async function updateLogs(ids: string[], patch: Record<string, unknown>, onlySubmitting = false) {
  await chunked(ids, DB_CHUNK, async (part) => {
    let query = db().from("sms_send_logs").update(patch).in("id", part);
    // Never overwrite a status a callback may already have written.
    if (onlySubmitting) query = query.eq("delivery_status", "submitting");
    const { error } = await query;
    if (error) console.error("[sms-bulk] falha ao atualizar logs", { error: error.message });
  });
}

/** Revoked SMS consents among the given E.164 numbers, one query per chunk. */
async function revokedSubjects(tenantId: string, phones: string[]): Promise<Set<string>> {
  const subjects = Array.from(new Set(phones.map((p) => normalizeConsentSubject("sms", p))));
  const revoked = new Set<string>();
  await chunked(subjects, DB_CHUNK, async (part) => {
    const { data, error } = await db()
      .from("channel_consents")
      .select("subject")
      .eq("tenant_id", tenantId)
      .eq("channel", "sms")
      .eq("status", "revoked")
      .in("subject", part);
    if (error) throw new Error(`Falha ao validar consentimento: ${error.message}`);
    for (const row of (data ?? []) as Array<{ subject: string }>) revoked.add(row.subject);
  });
  return revoked;
}

type ProviderCall =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "transport"; errorKind: "not_sent" | "outcome_unknown"; error: string; attempts: number };

/**
 * One Short Brasil bulk request. `tenantIds` are the tenants of every item in
 * the payload (a chunk may mix tenants); each passes the demo send guard right
 * before the request, and a DemoTenantBlockedError propagates (nothing sent).
 */
async function postBulk(tenantIds: readonly string[], payload: unknown): Promise<ProviderCall> {
  const { usuario, chave } = shortBrasilCredentials();
  let attempt = 0;
  while (true) {
    attempt++;
    await assertBatchTenantsCanSend(tenantIds);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMS_BULK_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(shortBrasilBulkUrl(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", usuario, chave },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { non_json: true, snippet: text.slice(0, 300) };
      }
      return { kind: "response", status: res.status, body };
    } catch (error) {
      // B1: only a request that provably never left is retried.
      const errorKind = transportErrorKind(error);
      const message = controller.signal.aborted
        ? `Short Brasil não respondeu em ${SMS_BULK_REQUEST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
      if (errorKind === "not_sent" && attempt < NOT_SENT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return { kind: "transport", errorKind, error: message, attempts: attempt };
    } finally {
      clearTimeout(timeout);
    }
  }
}

type BulkMapping = {
  /** parceiroId -> provider message id, only for keys of this chunk. */
  accepted: Map<string, string>;
  /** parceiroId -> reason, entries of this chunk explicitly reported as errors. */
  rejected: Map<string, string>;
  /** parceiroIds rejected with an ACCOUNT code (101/505): retryable, not the lead's fault. */
  accountRejected: Set<string>;
};

const ITEM_ERROR_CODES = new Set([101, 303, 404, 505]);

/**
 * Maps the bulk response to the keys that were sent in this chunk.
 *
 * Rule (ENV-10, QA B1): an item is rejected only when (a) its bulk[] entry
 * explicitly reports an error, or (b) bulk[] echoed SOME of the chunk's
 * parceiroIds and this one is absent (a partial match proves the echo works).
 * If bulk[] is missing/unparseable or echoes NONE of the sent parceiroIds
 * (e.g. entries without parceiroId), returns null: the whole chunk is treated
 * as outcome unknown (credit kept, never resent, never marked rejected).
 */
function mapBulkResponse(body: unknown, sentKeys: Set<string>): BulkMapping | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const list = (body as Record<string, unknown>).bulk;
  if (!Array.isArray(list)) return null;
  const mapping: BulkMapping = { accepted: new Map(), rejected: new Map(), accountRejected: new Set() };
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const parceiroId = typeof e.parceiroId === "string" ? e.parceiroId : null;
    if (!parceiroId || !sentKeys.has(parceiroId)) continue;
    const id = typeof e.id === "string" || typeof e.id === "number" ? String(e.id) : "";
    const appStatus = getShortBrasilAppStatus(e);
    const explicitError =
      (appStatus !== null && ITEM_ERROR_CODES.has(appStatus)) ||
      e.error !== undefined ||
      e.erro !== undefined;
    if (explicitError) {
      const detail = e.statusDetalhe ?? e.detalhe ?? e.error ?? e.erro ?? appStatus;
      mapping.rejected.set(parceiroId, `Short Brasil recusou a mensagem: ${String(detail)}`);
      if (appStatus === 101 || appStatus === 505) mapping.accountRejected.add(parceiroId);
    } else if (id) {
      mapping.accepted.set(parceiroId, id);
    }
  }
  if (mapping.accepted.size === 0 && mapping.rejected.size === 0) return null;
  return mapping;
}

function loteId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/**
 * Sends one chunk that already has logs written ahead and credits reserved.
 * Returns the outcome per prepared item (same order).
 */
async function sendChunk(chunk: Prepared[]): Promise<{
  outcomes: Array<Omit<SmsBatchOutcome, "deliveryKey">>;
  lote: string | null;
}> {
  const payload = {
    bulk: chunk.map((p) => ({
      celular: p.cell,
      mensagem: p.content,
      parceiroId: p.item.deliveryKey,
    })),
  };

  const refund = async (items: Prepared[], reason: string) =>
    runLimited(items, CREDIT_CONCURRENCY, async (p) => {
      if (p.billingReferenceId)
        await refundSmsCredit(p.item.tenantId, p.billingReferenceId, reason);
    });
  const dispatches = (items: Prepared[]) => items.flatMap((p) => p.dispatchIds);

  const unknown = async (reason: string, errorKind: ProviderErrorKind | null) => {
    await updateLogs(
      chunk.map((p) => p.logId),
      { delivery_status: "unconfirmed", error: reason },
      true,
    );
    await markTrackedDispatchesSent(dispatches(chunk));
    console.warn("[sms-bulk] outcome unknown; items kept as sent, awaiting callback", {
      items: chunk.length,
      reason,
    });
    return {
      lote: null,
      outcomes: chunk.map(() => ({
        status: "pending_confirmation" as const,
        ok: true,
        retryable: false,
        errorKind,
        error: reason,
      })),
    };
  };
  const wholeChunkFailed = async (
    reason: string,
    retryable: boolean,
    errorKind: ProviderErrorKind | null,
    insufficientFunds = false,
  ) => {
    await updateLogs(
      chunk.map((p) => p.logId),
      { status: "error", delivery_status: "failed", error: reason },
    );
    await refund(chunk, reason);
    await markTrackedDispatchesFailed(dispatches(chunk));
    return {
      lote: null,
      outcomes: chunk.map(() => ({
        status: "failed" as const,
        ok: false,
        retryable,
        errorKind,
        error: reason,
        insufficientFunds,
      })),
    };
  };

  const sendStartedAt = new Date();
  let call: ProviderCall;
  try {
    call = await postBulk(chunk.map((p) => p.item.tenantId), payload);
  } catch (error) {
    if (!isDemoBlockedError(error)) throw error;
    // Only reachable if a tenant turned demo after sendSmsBatch's own guard:
    // nothing left, so the write-ahead rows and credits are released as failed.
    return wholeChunkFailed(error.message, false, null);
  }

  if (call.kind === "transport") {
    if (call.errorKind === "outcome_unknown") return unknown(call.error, "outcome_unknown");
    return wholeChunkFailed(`Sem resposta do provedor: ${call.error}`, true, "not_sent");
  }

  const appStatus = getShortBrasilAppStatus(call.body);
  const mapping = mapBulkResponse(call.body, new Set(chunk.map((p) => p.item.deliveryKey)));
  if (!mapping) {
    // A request-level answer with an application code was not processed.
    // 101/505 and HTTP 401/402/403 refuse the ACCOUNT (incident 15/10/2026:
    // 101 = route without balance): refunded, retryable, breaker opened.
    const accountReason = smsProviderAccountReason(call.status, call.body);
    if (accountReason) {
      const reason = summarizeProviderError(call.status, call.body);
      await reportSmsProviderAccountFailure({ reason: accountReason, error: reason, sendStartedAt });
      return wholeChunkFailed(reason, true, "provider_account", accountReason === "no_balance");
    }
    if (call.status === 429) {
      return wholeChunkFailed(summarizeProviderError(call.status, call.body), true, null);
    }
    if (appStatus === 303 || appStatus === 404 || (call.status >= 400 && call.status < 500)) {
      return wholeChunkFailed(summarizeProviderError(call.status, call.body), false, null);
    }
    // 5xx, a 2xx we cannot read, or a bulk[] that echoes none of our
    // parceiroIds: the provider may have accepted it.
    return unknown(
      `Resposta do provedor sem confirmação por item (HTTP ${call.status}); aguardando callback`,
      "outcome_unknown",
    );
  }

  const map = mapping.accepted;
  const lote = loteId(call.body);
  if (map.size > 0) await noteSmsProviderSuccess(sendStartedAt);
  if (mapping.accountRejected.size > 0) {
    const first = chunk.find((p) => mapping.accountRejected.has(p.item.deliveryKey));
    await reportSmsProviderAccountFailure({
      reason: "auth",
      error: first ? (mapping.rejected.get(first.item.deliveryKey) ?? "Short Brasil 101/505") : "Short Brasil 101/505",
      sendStartedAt,
    });
  }
  const ok = chunk.filter((p) => map.has(p.item.deliveryKey));
  const rejected = chunk.filter((p) => !map.has(p.item.deliveryKey));
  const absentReason = "Short Brasil não aceitou esta mensagem no lote";
  const reasonFor = (p: Prepared) => mapping.rejected.get(p.item.deliveryKey) ?? absentReason;

  if (ok.length > 0) {
    // Provider id per row: one upsert. delivery_status/error/last_callback are
    // left out so an early callback is never overwritten.
    const { error } = await db()
      .from("sms_send_logs")
      .upsert(
        ok.map((p) => ({
          id: p.logId,
          to_phone: p.phone,
          content: p.content,
          status: "sent",
          provider: "short-brasil",
          idempotency_key: p.item.deliveryKey,
          provider_message_id: map.get(p.item.deliveryKey)!,
          provider_response: {
            bulk: true,
            lote_id: lote,
            id: map.get(p.item.deliveryKey)!,
            parceiroId: p.item.deliveryKey,
            billing_reference_id: p.billingReferenceId,
            credit_reserved: Boolean(p.billingReferenceId),
          },
          player_id: p.item.playerId,
          trigger_name: p.item.triggerName ?? null,
          tenant_id: p.item.tenantId,
        })),
        { onConflict: "id" },
      );
    if (error) console.error("[sms-bulk] falha ao gravar ids do provedor", { error: error.message });
    await updateLogs(
      ok.map((p) => p.logId),
      { delivery_status: "sent" },
      true,
    );
    await markTrackedDispatchesSent(dispatches(ok));
  }
  if (rejected.length > 0) {
    for (const [reason, group] of groupBy(rejected, reasonFor)) {
      await updateLogs(
        group.map((p) => p.logId),
        { status: "error", delivery_status: "failed", error: reason },
      );
      await refund(group, reason);
    }
    await markTrackedDispatchesFailed(dispatches(rejected));
  }
  console.info("[sms-bulk] lote enviado", {
    lote,
    items: chunk.length,
    accepted: ok.length,
    rejected: rejected.length,
  });
  return {
    lote,
    outcomes: chunk.map((p) =>
      map.has(p.item.deliveryKey)
        ? {
            status: "accepted" as const,
            ok: true,
            retryable: false,
            providerMessageId: map.get(p.item.deliveryKey)!,
            logId: p.logId,
          }
        : mapping.accountRejected.has(p.item.deliveryKey)
          ? {
              // Refunded above; the account was refused, not this number.
              status: "failed" as const,
              ok: false,
              retryable: true,
              errorKind: "provider_account" as const,
              error: reasonFor(p),
              logId: p.logId,
            }
          : {
              status: "rejected" as const,
              ok: false,
              retryable: false,
              error: reasonFor(p),
              logId: p.logId,
            },
    ),
  };
}

/**
 * Demo send guard for every distinct tenant of a batch. Throws only the
 * DemoTenantBlockedError (DEMO_SEND_BLOCKED, fail-closed for an empty or
 * unknown tenant); other tenant states (suspended/canceled) are left to the
 * existing checks so their behaviour is unchanged.
 */
async function assertBatchTenantsCanSend(tenantIds: Iterable<string>) {
  const ids = Array.from(new Set(tenantIds));
  if (ids.length === 0) await assertTenantNotDemoForSend(null);
  for (const tenantId of ids) await assertTenantNotDemoForSend(tenantId);
}

/** Thrown before anything is charged or sent: the caller must retry the whole batch later. */
export class SmsBatchDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsBatchDeferredError";
  }
}

/**
 * Sends a batch of personalised SMS. Outcomes come back in input order.
 * Throws SmsBatchDeferredError (nothing charged or sent) when the tenant is
 * blocked or link tracking is in 'block' mode and links could not be prepared.
 * Throws DemoTenantBlockedError (DEMO_SEND_BLOCKED, nothing written) when any
 * item belongs to a demo or unknown tenant.
 */
export async function sendSmsBatch(items: SmsBatchItem[]): Promise<SmsBatchResult> {
  const outcomes: Array<SmsBatchOutcome | undefined> = new Array(items.length);
  const result = (lotes: string[], httpCalls: number): SmsBatchResult => ({
    outcomes: outcomes as SmsBatchOutcome[],
    lotes,
    httpCalls,
  });
  if (items.length === 0) return result([], 0);

  // Demo guard for the whole batch, before any transport choice, log, credit
  // or link: one demo (or unknown) tenant rejects the batch with
  // DemoTenantBlockedError and no per-recipient row is written.
  await assertBatchTenantsCanSend(items.map((i) => i.tenantId));

  const transport = smsBulkTransport();
  if (transport === "misconfigured") {
    items.forEach((item, i) => {
      outcomes[i] = {
        deliveryKey: item.deliveryKey,
        status: "failed",
        ok: false,
        retryable: true,
        errorKind: "misconfigured",
        error: "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados",
      };
    });
    return result([], 0);
  }
  if (transport === "single") {
    // Bearer (Short Code) API: no per-item bulk endpoint; keep the single path.
    await runLimited(
      items.map((item, index) => ({ item, index })),
      10,
      async ({ item, index }) => {
        const r = await sendSmsInternal({
          to: item.to,
          content: item.content,
          playerId: item.playerId,
          triggerName: item.triggerName ?? null,
          tenantId: item.tenantId,
          linkTrackingEnabled: item.linkTrackingEnabled,
          linkTrackingOrigin: item.linkTrackingOrigin,
          deliveryKey: item.deliveryKey,
        });
        const alreadySent = "alreadySent" in r && r.alreadySent === true;
        const providerAccount =
          !r.ok && (r as { errorKind?: unknown }).errorKind === "provider_account";
        outcomes[index] = {
          deliveryKey: item.deliveryKey,
          status: r.ok ? (alreadySent ? "already_sent" : "accepted") : "failed",
          ok: r.ok,
          retryable: providerAccount,
          ...(providerAccount ? { errorKind: "provider_account" as const } : {}),
          error: r.ok ? undefined : (r as { error?: string }).error,
        };
      },
    );
    return result([], 0);
  }

  // 0. Tenant status (throws -> nothing done).
  for (const tenantId of new Set(items.map((i) => i.tenantId))) {
    try {
      await assertTenantCanOperate(tenantId);
    } catch (error) {
      throw new SmsBatchDeferredError(error instanceof Error ? error.message : String(error));
    }
  }

  // a. Already accepted deliveries are never sent again.
  const acceptedKeys = await findAcceptedDeliveryKeys(
    supabaseAdmin as unknown as CampaignDb,
    items.map((i) => i.deliveryKey),
  );
  const seen = new Set<string>();
  const failLogs: LogRow[] = [];
  const candidates: Array<{ index: number; item: SmsBatchItem; phone: string; cell: string }> = [];
  items.forEach((item, index) => {
    if (acceptedKeys.has(item.deliveryKey) || seen.has(item.deliveryKey)) {
      outcomes[index] = {
        deliveryKey: item.deliveryKey,
        status: "already_sent",
        ok: true,
        retryable: false,
      };
      return;
    }
    seen.add(item.deliveryKey);
    try {
      const phone = requireBrazilianPhone(item.to);
      candidates.push({ index, item, phone, cell: toShortBrasilCell(phone) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      outcomes[index] = { deliveryKey: item.deliveryKey, status: "failed", ok: false, retryable: false, error: msg };
      failLogs.push(
        logRow({
          id: crypto.randomUUID(),
          to_phone: item.to,
          content: item.content,
          status: "error",
          provider_response: {},
          error: msg,
          idempotency_key: null,
          provider_message_id: null,
          delivery_status: "failed",
          player_id: item.playerId,
          trigger_name: item.triggerName ?? null,
          tenant_id: item.tenantId,
        }),
      );
    }
  });

  // Consent (one query per tenant/chunk).
  const byTenant = new Map<string, typeof candidates>();
  for (const c of candidates) byTenant.set(c.item.tenantId, [...(byTenant.get(c.item.tenantId) ?? []), c]);
  const sendable: typeof candidates = [];
  for (const [tenantId, list] of byTenant) {
    const revoked = await revokedSubjects(tenantId, list.map((c) => c.phone));
    for (const c of list) {
      if (!revoked.has(normalizeConsentSubject("sms", c.phone))) {
        sendable.push(c);
        continue;
      }
      outcomes[c.index] = {
        deliveryKey: c.item.deliveryKey,
        status: "failed",
        ok: false,
        retryable: false,
        suppressed: true,
        error: "Destinatario bloqueado por consentimento",
      };
      failLogs.push(
        logRow({
          id: crypto.randomUUID(),
          to_phone: c.phone,
          content: c.item.content,
          status: "error",
          provider_response: { suppressed: true, reason: "consent_revoked" },
          error: "Destinatario revogou o consentimento para SMS",
          idempotency_key: c.item.deliveryKey,
          provider_message_id: null,
          delivery_status: "failed",
          player_id: c.item.playerId,
          trigger_name: c.item.triggerName ?? null,
          tenant_id: tenantId,
        }),
      );
    }
  }
  sendable.sort((a, b) => a.index - b.index);

  // c. Tracked links for every sendable item (bulk Short.io + set-based DB).
  const logIds = sendable.map(() => crypto.randomUUID());
  const links = await prepareTrackedTextBatch(
    sendable.map((c, k) => ({
      content: c.item.content,
      context: {
        tenantId: c.item.tenantId,
        channel: "sms" as const,
        sourceType: c.item.linkTrackingOrigin?.sourceType ?? "manual",
        sourceId: c.item.linkTrackingOrigin?.sourceId ?? c.item.triggerName ?? null,
        journeyStepId: c.item.linkTrackingOrigin?.journeyStepId ?? null,
        journeyStepPosition: c.item.linkTrackingOrigin?.journeyStepPosition ?? null,
        shortDomainId: c.item.linkTrackingOrigin?.shortDomainId ?? null,
        recipientPlayerId: c.item.playerId,
        recipientHash: c.item.linkTrackingOrigin?.recipientHash ?? null,
        messageLogType: "sms_send_logs",
        messageLogId: logIds[k],
        deliveryKey: c.item.deliveryKey,
        enabled: c.item.linkTrackingEnabled,
      },
    })),
  );
  const blocked = links.find(
    (l): l is Extract<typeof l, { ok: false }> => !l.ok && l.fallbackMode === "block",
  );
  if (blocked) {
    // Tenant chose 'block': do not send untracked; nothing charged yet.
    throw new SmsBatchDeferredError(`Rastreamento de links indisponível: ${blocked.error}`);
  }

  // b. Credits, one deterministic reservation per delivery key.
  const prepared: Prepared[] = [];
  await runLimited(
    sendable.map((c, k) => ({ c, k })),
    CREDIT_CONCURRENCY,
    async ({ c, k }) => {
      const link = links[k];
      const content = link.ok ? link.content : c.item.content;
      const dispatchIds = link.ok ? link.links.map((l) => l.dispatchId) : [];
      const reservation = await reserveSmsCreditForDelivery(c.item.tenantId, c.item.deliveryKey);
      if (!reservation.ok) {
        outcomes[c.index] = {
          deliveryKey: c.item.deliveryKey,
          status: "failed",
          ok: false,
          retryable: false,
          error: reservation.error,
        };
        failLogs.push(
          logRow({
            id: logIds[k],
            to_phone: c.phone,
            content,
            status: "error",
            provider_response: { billing_reference_id: reservation.referenceId },
            error: reservation.error,
            idempotency_key: null,
            provider_message_id: null,
            delivery_status: "failed",
            player_id: c.item.playerId,
            trigger_name: c.item.triggerName ?? null,
            tenant_id: c.item.tenantId,
          }),
        );
        await markTrackedDispatchesFailed(dispatchIds);
        return;
      }
      prepared.push({
        index: c.index,
        item: c.item,
        phone: c.phone,
        cell: c.cell,
        logId: logIds[k],
        content,
        dispatchIds,
        billingReferenceId: reservation.referenceId,
      });
    },
  );
  prepared.sort((a, b) => a.index - b.index);
  if (failLogs.length > 0) await insertLogs(failLogs);

  // d/e/f. One HTTP call per chunk.
  const lotes: string[] = [];
  let httpCalls = 0;
  for (let offset = 0; offset < prepared.length; offset += SMS_BULK_CHUNK_SIZE) {
    const chunk = prepared.slice(offset, offset + SMS_BULK_CHUNK_SIZE);
    try {
      // Write-ahead: the key counts as accepted before the request leaves.
      await insertLogs(
        chunk.map((p) =>
          logRow({
            id: p.logId,
            to_phone: p.phone,
            content: p.content,
            status: "sent",
            provider_response: {
              bulk: true,
              phase: "submitting",
              billing_reference_id: p.billingReferenceId,
              credit_reserved: Boolean(p.billingReferenceId),
            },
            error: null,
            idempotency_key: p.item.deliveryKey,
            provider_message_id: null,
            delivery_status: "submitting",
            player_id: p.item.playerId,
            trigger_name: p.item.triggerName ?? null,
            tenant_id: p.item.tenantId,
          }),
        ),
      );
    } catch (error) {
      // Nothing sent: release the credits and let the caller retry later.
      const reason = error instanceof Error ? error.message : String(error);
      await runLimited(chunk, CREDIT_CONCURRENCY, async (p) => {
        if (p.billingReferenceId) await refundSmsCredit(p.item.tenantId, p.billingReferenceId, reason);
      });
      await markTrackedDispatchesFailed(chunk.flatMap((p) => p.dispatchIds));
      for (const p of chunk)
        outcomes[p.index] = {
          deliveryKey: p.item.deliveryKey,
          status: "failed",
          ok: false,
          retryable: true,
          error: reason,
        };
      continue;
    }
    httpCalls++;
    const sent = await sendChunk(chunk);
    if (sent.lote) lotes.push(sent.lote);
    chunk.forEach((p, k) => {
      outcomes[p.index] = { deliveryKey: p.item.deliveryKey, logId: p.logId, ...sent.outcomes[k] };
    });
  }
  return result(lotes, httpCalls);
}

// ------------------------------------------------------------------
// QA I2 — reconciliation of write-ahead rows that never left 'submitting'.
//
// A row stays 'submitting' only if the worker died between the write-ahead
// insert and the end of the provider call. It may or may not have been sent,
// so it is NEVER resent: after 30 min without callback it moves to
// 'unconfirmed' (still counts as accepted) and is reported to Sentry for a
// manual check against the provider panel. A later callback still wins
// (the webhook matches by parceiroId / provider id).
//
// Scheduled from runScheduledSmsCampaigns (cron 1x/min) at most every 5 min
// while SMS_BULK_ENABLED=true. Manual equivalent (read-only check):
//   SELECT id, tenant_id, idempotency_key, created_at FROM sms_send_logs
//    WHERE created_at >= now() - interval '7 days'
//      AND created_at <  now() - interval '30 minutes'
//      AND delivery_status = 'submitting';
// ------------------------------------------------------------------

export const SUBMITTING_STALE_MINUTES = 30;
/** Bounded lookback so the scan uses the created_at index (sms_send_logs is large). */
const RECONCILE_LOOKBACK_MS = 7 * 86_400_000;

export async function reconcileStaleSubmittingLogs(
  opts: { now?: number; olderThanMinutes?: number; limit?: number } = {},
): Promise<{ moved: number; ids: string[] }> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - (opts.olderThanMinutes ?? SUBMITTING_STALE_MINUTES) * 60_000);
  const since = new Date(now - RECONCILE_LOOKBACK_MS);
  const { data, error } = await db()
    .from("sms_send_logs")
    .select("id,tenant_id,idempotency_key,created_at")
    .gte("created_at", since.toISOString())
    .lt("created_at", cutoff.toISOString())
    .eq("delivery_status", "submitting")
    .limit(opts.limit ?? 1000);
  if (error) throw new Error(`Falha ao listar envios em 'submitting': ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; tenant_id: string | null }>;
  if (rows.length === 0) return { moved: 0, ids: [] };
  const ids = rows.map((r) => r.id);
  await updateLogs(
    ids,
    {
      delivery_status: "unconfirmed",
      error: `Sem resposta do provedor nem callback após ${opts.olderThanMinutes ?? SUBMITTING_STALE_MINUTES} min (envio em lote interrompido); não reenviado`,
    },
    true,
  );
  const tenants = Array.from(new Set(rows.map((r) => r.tenant_id ?? "unknown")));
  console.error("[sms-bulk] write-ahead rows without provider outcome", {
    count: ids.length,
    tenants,
  });
  captureServerException(
    new Error(`SMS bulk: ${ids.length} envio(s) presos em 'submitting' movidos para 'unconfirmed'`),
    {
      job: "sms_bulk_reconcile",
      tags: { count: ids.length },
      extra: { tenants, sampleIds: ids.slice(0, 20) },
    },
  );
  return { moved: ids.length, ids };
}
