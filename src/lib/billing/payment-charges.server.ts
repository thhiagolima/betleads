// Confirms and records Pix charge state (server-only), for every gateway
// (Upper, SpacePay) behind the `PixGateway` seam (pix-gateway.server.ts).
// The webhooks (src/routes/api/public/upper/webhook.ts,
// src/routes/api/public/spacepay/webhook.$token.ts) and the reconciliation
// cron (Task 5) all call `confirmCharge`; crediting is only ever done
// through `billing_credit_paid_charge` (service_role RPC, Task 1), after a
// fresh `gateway.get` — always through the gateway stored on the charge's
// own `provider` column — confirms `status = 'PAID'` with a matching paid
// amount. A webhook is just a hint to go check, never a source of truth.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

import { invalidateTenantStatusCache } from "@/lib/tenant-access.server";

import { sendBillingEmail } from "./billing-emails.server";
import { maskDocumentsDeep, maskPayerDocument } from "./payer";
import {
  getPixGateway,
  isPixNotFound,
  PixGatewayError,
  type PixCharge,
} from "./pix-gateway.server";

export type ConfirmChargeOutcome =
  | "credited"
  | "already_credited"
  | "not_paid"
  | "needs_review"
  | "unknown_charge";

const TERMINAL_UNPAID_STATUSES = new Set(["EXPIRED", "CANCELLED", "FAILED"]);

/**
 * `charge.raw` is the gateway's response (Upper: the raw body; SpacePay: an
 * allow-list of scalar fields, see spacepay-pix.server), stored for
 * superadmin diagnostics only (`payment_charges.last_provider_payload`). As a
 * second layer (LGPD), every document-like key (`document`, `cpf`, `cnpj`,
 * ... — see maskDocumentsDeep), at any depth, is replaced with its masked
 * value before it is written anywhere.
 */
function sanitizeProviderPayload(raw: unknown): Json {
  return maskDocumentsDeep(raw).value as Json;
}

/**
 * Writes the latest known state of a charge from its Pix gateway. Sets
 * `needs_review` when the charge is reported PAID but the paid amount does
 * not match OUR stored `amount_cents` (never the gateway's own `amountCents` —
 * that only proves the gateway is self-consistent, not that it matches what we
 * actually charged). Never writes `needs_review = false`: a flag set here
 * earlier, or by the super admin, must survive every later snapshot — only
 * a human resolving the case clears it (out of scope here). For a terminal
 * unpaid status (EXPIRED/CANCELLED/FAILED), also marks the linked
 * credit_topup_orders row with the matching lowercase status — only while
 * that order is still 'pending', and only if the charge row was actually
 * updated.
 *
 * Money received always wins: a snapshot whose status is not PAID never
 * overwrites a row already PAID (the update is conditional at the DB level,
 * so it also holds against a concurrent PAID write), and a PENDING/ACTIVE
 * snapshot never reopens a row already closed locally; a PAID snapshot
 * may move an EXPIRED/FAILED/CANCELLED row to PAID so the late payment gets
 * credited. `paid_at`/`paid_amount_cents` are only written when this
 * snapshot carries a value, never nulled over an existing one.
 */
export async function recordChargeSnapshot(chargeId: string, charge: PixCharge): Promise<void> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("payment_charges")
    .select("ref_id, kind, amount_cents")
    .eq("id", chargeId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new Error("charge_not_found");

  type PaymentChargeUpdate = Database["public"]["Tables"]["payment_charges"]["Update"];
  const patch: PaymentChargeUpdate = {
    status: charge.status,
    payer_name: charge.payer?.name ?? null,
    payer_document_masked: maskPayerDocument(charge.payer?.document ?? null),
    last_provider_payload: sanitizeProviderPayload(charge.raw),
    updated_at: new Date().toISOString(),
  };

  // Pix checkout details (the purchase screen's QR/EMV/link/expiry): only
  // ever written when THIS snapshot actually carries a value. A later GET
  // (e.g. the reconciliation cron polling a charge close to/after expiry)
  // can omit fields the create response had, and must never erase what was
  // already recorded.
  if (charge.id) patch.provider_charge_id = charge.id;
  if (charge.paidAt !== null) patch.paid_at = charge.paidAt;
  if (charge.paidAmountCents !== null) patch.paid_amount_cents = charge.paidAmountCents;
  if (charge.emv !== null) patch.emv = charge.emv;
  if (charge.qrCodeImage !== null) patch.qr_code_image = charge.qrCodeImage;
  if (charge.paymentUrl !== null) patch.payment_url = charge.paymentUrl;
  if (charge.expiresAt !== null) patch.expires_at = charge.expiresAt;

  if (charge.status === "PAID") {
    const amountMismatch =
      charge.paidAmountCents === null || charge.paidAmountCents !== existing.amount_cents;
    if (amountMismatch) {
      patch.needs_review = true;
    }
    // A match never resets needs_review to false — see the doc comment above.
  }

  let update = supabaseAdmin.from("payment_charges").update(patch).eq("id", chargeId);
  if (charge.status === "PENDING" || charge.status === "ACTIVE") {
    // Never "reopens" a charge we already closed locally (EXPIRED/FAILED/
    // CANCELLED, e.g. by the reconcile cron while the gateway still says
    // ACTIVE),
    // nor un-pays a PAID one.
    update = update.in("status", ["PENDING", "ACTIVE"]);
  } else if (charge.status !== "PAID") {
    update = update.neq("status", "PAID");
  }
  const { data: updated, error: updateError } = await update.select("id");
  if (updateError) throw new Error(updateError.message);
  const chargeUpdated = (updated ?? []).length > 0;

  if (
    chargeUpdated &&
    TERMINAL_UNPAID_STATUSES.has(charge.status) &&
    existing.kind === "credit_topup"
  ) {
    const { error: orderError } = await supabaseAdmin
      .from("credit_topup_orders")
      .update({ status: charge.status.toLowerCase() })
      .eq("id", existing.ref_id)
      .eq("status", "pending");
    if (orderError) throw new Error(orderError.message);
  }
}

type BillingCreditPaidChargeResult = {
  ok: boolean;
  idempotent?: boolean;
  // invoice_not_open / invoice_not_found: invoice branch (mensalidade
  // Task 2) — a Pix paid against an invoice that was already paid/canceled
  // or does not exist. The RPC flags the charge needs_review in those cases
  // (and on an invoice amount_mismatch), so it is never retried forever.
  reason?:
    | "not_paid"
    | "needs_review"
    | "amount_mismatch"
    | "invoice_not_open"
    | "invoice_not_found";
};

/**
 * A settled invoice changes the house's billing state (the SQL settle
 * recomputes `access_state`): drop the house from the 5 s guard cache so it
 * unlocks at once in this process instead of up to 5 s later — awaited
 * (cheap, in-memory). Also fires the 'paid' billing e-mail (Task 5),
 * fire-and-forget: a per-recipient send loop over the platform e-mail
 * provider must never add its latency to the Pix webhook/reconcile
 * response. Failure (provider down, outside the send window, whatever) is
 * only logged, never thrown into the payment path; the hourly sweep
 * (`sendPendingBillingEmails`) still picks up any invoice paid in the last
 * 48h without a 'paid' log, so a lost/slow send here is not the only chance.
 */
function refreshTenantAfterInvoiceSettle(charge: {
  kind?: string | null;
  tenant_id?: string | null;
  ref_id?: string | null;
}) {
  if (charge.kind !== "invoice" || !charge.tenant_id) return;
  invalidateTenantStatusCache(charge.tenant_id);
  if (!charge.ref_id) return;
  void sendBillingEmail(charge.ref_id, "paid").catch((err) => {
    console.error("[billing/payment-charges] 'paid' e-mail failed", {
      invoiceId: charge.ref_id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * SpacePay maps `refunded` to FAILED, and a FAILED snapshot never overwrites a
 * PAID row (recordChargeSnapshot), so a refund of money we already took
 * would go unnoticed. Flags the row for a human instead (needs_review is
 * sticky; nothing is debited automatically). Only SpacePay exposes the raw
 * status: its `raw` is an allow-list carrying `status` (spacepay-pix.server).
 */
async function flagRefundedPaidCharge(
  chargeRow: {
    id: string;
    provider: string | null;
    status: string | null;
    credited_at: string | null;
    needs_review: boolean | null;
  },
  charge: PixCharge,
): Promise<void> {
  if (chargeRow.provider !== "spacepay") return;
  const rawStatus = (charge.raw as { status?: unknown } | null)?.status;
  if (rawStatus !== "refunded") return;
  if (chargeRow.status !== "PAID" && !chargeRow.credited_at) return;

  console.error("[billing/payment-charges] SpacePay refunded a paid charge; flagged needs_review", {
    chargeId: chargeRow.id,
    credited: Boolean(chargeRow.credited_at),
  });
  if (chargeRow.needs_review) return;
  const { error } = await supabaseAdmin
    .from("payment_charges")
    .update({ needs_review: true, updated_at: new Date().toISOString() })
    .eq("id", chargeRow.id);
  if (error) throw new Error(error.message);
}

/**
 * The only place that turns a webhook/cron hint into an actual credit.
 * Always re-fetches the charge from the gateway that owns it (the row's own
 * `provider`, never the currently active one) first — never trusts a
 * webhook payload's own numbers — and only calls the crediting RPC when that
 * fresh read says PAID with a matching paid amount. Gateway errors
 * (PixGatewayError, e.g. a 404) propagate to the caller.
 */
export async function confirmCharge(
  externalId: string,
): Promise<{ outcome: ConfirmChargeOutcome }> {
  const { data: chargeRow, error: findError } = await supabaseAdmin
    .from("payment_charges")
    .select(
      "id, amount_cents, needs_review, kind, tenant_id, ref_id, provider, provider_charge_id, status, credited_at",
    )
    .eq("external_id", externalId)
    .maybeSingle();
  if (findError) throw new Error(findError.message);
  if (!chargeRow) return { outcome: "unknown_charge" };

  const gateway = getPixGateway(chargeRow.provider);
  const charge = await gateway.get({
    externalId,
    providerChargeId: chargeRow.provider_charge_id ?? null,
  });
  await recordChargeSnapshot(chargeRow.id, charge);
  await flagRefundedPaidCharge(chargeRow, charge);

  if (charge.status !== "PAID") return { outcome: "not_paid" };

  // Compare against OUR stored amount_cents, never the gateway's own amountCents
  // (see recordChargeSnapshot). A review flag already set (by this check or
  // by a super admin) is sticky and blocks crediting even if this payment
  // matches — never decided locally only; the RPC enforces the same rule
  // server-side as a second layer.
  const amountMismatch =
    charge.paidAmountCents === null || charge.paidAmountCents !== chargeRow.amount_cents;
  if (chargeRow.needs_review || amountMismatch) {
    return { outcome: "needs_review" };
  }

  const { data, error } = await supabaseAdmin.rpc("billing_credit_paid_charge", {
    _charge_id: chargeRow.id,
  });
  if (error) throw new Error(error.message);

  const result = data as BillingCreditPaidChargeResult | null;
  if (result?.ok) {
    refreshTenantAfterInvoiceSettle(chargeRow);
    return { outcome: result.idempotent ? "already_credited" : "credited" };
  }
  if (
    result?.reason === "needs_review" ||
    result?.reason === "amount_mismatch" ||
    result?.reason === "invoice_not_open" ||
    result?.reason === "invoice_not_found"
  ) {
    return { outcome: "needs_review" };
  }
  return { outcome: "not_paid" };
}

/** Pre-SpacePay name, kept for existing callers; same as `confirmCharge`. */
export const confirmChargeFromUpper = confirmCharge;

export type ReconcileResult = {
  checked: number;
  credited: number;
  expired: number;
  errors: number;
};

const PENDING_CUTOFF_MS = 2 * 60_000;
const EXPIRY_GRACE_MS = 10 * 60_000;
/**
 * A charge the gateway has never heard of (404 on confirm/gateway.get)
 * usually just means we are racing the gateway's own create — give it this long before
 * giving up for good. Below this age, a 404 only counts as an error.
 */
const NOT_FOUND_FAIL_AGE_MS = 15 * 60_000;
const DEFAULT_RECONCILE_LIMIT = 30;
/**
 * Separate, small budget for the "PAID locally but never credited" sweep
 * (ruling 1): this batch never calls a gateway, so it does not compete with the
 * caller-provided `limit` for the PENDING/ACTIVE batch below.
 */
const LOCALLY_PAID_LIMIT = 30;
/**
 * Terminal-but-uncredited sweep: EXPIRED/FAILED/CANCELLED charges younger
 * than this are still re-checked with their gateway, since a payment can land after
 * we gave up locally (a late PAID, a create that timed out on our side but
 * went through on the gateway's, a webhook lost while the row was being expired).
 */
const TERMINAL_RECHECK_WINDOW_MS = 48 * 60 * 60_000;
const TERMINAL_RECHECK_LIMIT = 10;

function logReconcileError(
  context: string,
  err: unknown,
  externalId: string,
  provider: string | null = null,
): void {
  if (err instanceof PixGatewayError) {
    console.error(`[billing-reconcile] ${context}`, {
      provider: err.provider,
      code: err.code,
      status: err.status,
      externalId,
    });
  } else {
    console.error(`[billing-reconcile] ${context}`, {
      provider,
      error: err instanceof Error ? err.message : "unknown error",
      externalId,
    });
  }
}

/**
 * Catches up charges already PAID in our own table whose credit never
 * landed (e.g. the RPC call failed right after a snapshot was recorded).
 * Credits directly through the RPC — no gateway is called here, the charge
 * is already known PAID from our side.
 */
async function creditLocallyPaidCharges(result: ReconcileResult): Promise<void> {
  const { data: rows, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id, kind, tenant_id, ref_id, provider")
    .eq("status", "PAID")
    .is("credited_at", null)
    .eq("needs_review", false)
    .order("created_at", { ascending: true })
    .limit(LOCALLY_PAID_LIMIT);
  if (error) throw new Error(error.message);

  for (const row of rows ?? []) {
    try {
      const { data, error: rpcError } = await supabaseAdmin.rpc("billing_credit_paid_charge", {
        _charge_id: row.id,
      });
      if (rpcError) throw new Error(rpcError.message);
      const rpcResult = data as BillingCreditPaidChargeResult | null;
      if (rpcResult?.ok) {
        result.credited += 1;
        refreshTenantAfterInvoiceSettle(row);
      }
    } catch (err) {
      result.errors += 1;
      logReconcileError("error crediting locally-paid charge", err, row.external_id, row.provider);
    }
  }
}

/**
 * A charge its gateway still reports ACTIVE more than EXPIRY_GRACE_MS past
 * our stored `expires_at` is dead on the gateway's own terms (the PIX QR
 * expired — also SpacePay's short-lived QR)
 * even though they have not flipped its status yet. Marks it EXPIRED locally
 * so it stops being retried forever. Never touches a charge that is not
 * (still) ACTIVE, or that already carries a `credited_at` — crediting always
 * wins and is never undone here.
 */
async function maybeExpireStaleActiveCharge(
  chargeId: string,
  now: Date,
  result: ReconcileResult,
): Promise<void> {
  const { data: current, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, status, expires_at, credited_at, kind, ref_id")
    .eq("id", chargeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!current) return;
  if (current.status !== "ACTIVE") return;
  if (current.credited_at) return;
  if (!current.expires_at) return;

  const expiresAtMs = new Date(current.expires_at).getTime();
  if (now.getTime() - expiresAtMs <= EXPIRY_GRACE_MS) return;

  // Conditional at the DB level: a PAID snapshot (webhook) or a credit
  // landing between the read above and this write must win — then this
  // matches no row and nothing else is touched.
  const { data: expiredRows, error: updateError } = await supabaseAdmin
    .from("payment_charges")
    .update({ status: "EXPIRED", updated_at: now.toISOString() })
    .eq("id", current.id)
    .in("status", ["PENDING", "ACTIVE"])
    .is("credited_at", null)
    .select("id");
  if (updateError) throw new Error(updateError.message);
  if ((expiredRows ?? []).length === 0) return;

  if (current.kind === "credit_topup") {
    const { error: orderError } = await supabaseAdmin
      .from("credit_topup_orders")
      .update({ status: "expired" })
      .eq("id", current.ref_id)
      .eq("status", "pending");
    if (orderError) throw new Error(orderError.message);
  }

  result.expired += 1;
}

/**
 * A charge its gateway has never created (we crashed between inserting our
 * row and calling the gateway, or the call itself never reached them)
 * answers every `GET` with a 404 forever — it will never turn PAID. Once it
 * has been stuck long enough (NOT_FOUND_FAIL_AGE_MS) this gives up on it for
 * good: FAILED locally with `last_error = '<provider>_not_found'` (e.g.
 * 'upper_not_found', 'spacepay_not_found'), and its
 * credit_topup_order (if any) 'failed'. Never touches a charge that is
 * already credited, or whose status is PAID — a 404 reaching this point
 * for either would mean something else is very wrong, and crediting always
 * wins.
 */
async function markChargeFailedNotFound(
  chargeId: string,
  provider: string,
  nowIso: string,
): Promise<void> {
  const { data: current, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, status, credited_at, kind, ref_id")
    .eq("id", chargeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!current) return;
  if (current.credited_at) return;
  if (current.status === "PAID") return;

  // Same conditional write as maybeExpireStaleActiveCharge: never over a
  // row that turned PAID/credited after the read above.
  const { data: failedRows, error: updateError } = await supabaseAdmin
    .from("payment_charges")
    .update({ status: "FAILED", last_error: `${provider}_not_found`, updated_at: nowIso })
    .eq("id", current.id)
    .in("status", ["PENDING", "ACTIVE"])
    .is("credited_at", null)
    .select("id");
  if (updateError) throw new Error(updateError.message);
  if ((failedRows ?? []).length === 0) return;

  if (current.kind === "credit_topup") {
    const { error: orderError } = await supabaseAdmin
      .from("credit_topup_orders")
      .update({ status: "failed" })
      .eq("id", current.ref_id)
      .eq("status", "pending");
    if (orderError) throw new Error(orderError.message);
  }
}

/**
 * Re-checks recent terminal-but-uncredited charges (status EXPIRED, FAILED
 * or CANCELLED, credited_at null, not flagged needs_review, created within
 * TERMINAL_RECHECK_WINDOW_MS) through confirmCharge, so a payment its
 * gateway reports PAID after we gave up on the charge still gets credited.
 * Same fair ordering (oldest-checked first) and updated_at touch as the
 * PENDING/ACTIVE batch, on its own small TERMINAL_RECHECK_LIMIT budget. A
 * 404 here is expected (the gateway never created the charge — the usual reason
 * it is FAILED) and is not counted as an error.
 */
async function recheckTerminalUncreditedCharges(
  result: ReconcileResult,
  now: Date,
  nowIso: string,
  alreadyChecked: ReadonlySet<string>,
): Promise<void> {
  const since = new Date(now.getTime() - TERMINAL_RECHECK_WINDOW_MS).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id, provider")
    .in("status", ["EXPIRED", "FAILED", "CANCELLED"])
    .is("credited_at", null)
    .eq("needs_review", false)
    .gte("created_at", since)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(TERMINAL_RECHECK_LIMIT + alreadyChecked.size);
  if (error) throw new Error(error.message);

  // A charge the PENDING/ACTIVE batch just closed in this same run (expired
  // or failed) was already asked about a moment ago — skip it this time.
  const batch = (rows ?? [])
    .filter((row) => !alreadyChecked.has(row.id))
    .slice(0, TERMINAL_RECHECK_LIMIT);
  for (const row of batch) {
    result.checked += 1;
    try {
      const { outcome } = await confirmCharge(row.external_id);
      if (outcome === "credited" || outcome === "already_credited") {
        result.credited += 1;
      }
    } catch (err) {
      if (!isPixNotFound(err)) {
        result.errors += 1;
        logReconcileError("error rechecking terminal charge", err, row.external_id, row.provider);
      }
    }
    try {
      await touchChargeUpdatedAt(row.id, nowIso);
    } catch (touchErr) {
      logReconcileError(
        "error touching charge updated_at",
        touchErr,
        row.external_id,
        row.provider,
      );
    }
  }
}

async function touchChargeUpdatedAt(chargeId: string, nowIso: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payment_charges")
    .update({ updated_at: nowIso })
    .eq("id", chargeId);
  if (error) throw new Error(error.message);
}

/**
 * The 5-minute reconciliation sweep (Task 5): picks up any Pix charge whose
 * state might have drifted from its gateway's — a webhook that never arrived
 * or failed to process, a crediting RPC call that errored after a PAID
 * snapshot, or a PIX QR that quietly expired on the gateway's side. The
 * webhooks (Upper, SpacePay) are the fast path; this is the safety net, so
 * every outcome here must be safe to repeat. Each charge is checked through
 * the gateway stored on its own `provider` row (see confirmCharge), so
 * charges from both gateways are reconciled in the same pass.
 *
 * - Charges PAID locally but never credited are credited directly (ruling
 *   1), on a separate LOCALLY_PAID_LIMIT budget — see creditLocallyPaidCharges.
 * - PENDING/ACTIVE charges older than PENDING_CUTOFF_MS are re-checked
 *   against their gateway via confirmCharge, oldest first, up to `limit`
 *   (default DEFAULT_RECONCILE_LIMIT).
 * - A charge that comes back from that check still ACTIVE and long past its
 *   expiry is marked EXPIRED locally (ruling 2).
 * - A charge its gateway answers 404 for, once stuck more than
 *   NOT_FOUND_FAIL_AGE_MS, is given up on: FAILED locally with last_error
 *   '<provider>_not_found' ('upper_not_found' / 'spacepay_not_found'; a
 *   younger 404 just counts as an error, since it likely means we are
 *   racing the gateway's own create).
 * - Every charge this sweep checks — success or error — gets its
 *   `updated_at` touched to `now`, and the batch is selected oldest-checked
 *   first (`updated_at` ascending, nulls first, then `created_at`
 *   ascending), so a charge that keeps failing moves to the back of the
 *   queue instead of starving newer charges under the same `limit`.
 * - Recent EXPIRED/FAILED/CANCELLED charges never credited are re-checked
 *   too (see recheckTerminalUncreditedCharges), so a late PAID still credits.
 * - Any error on one charge (gateway or DB) is counted and never stops the
 *   rest (ruling 3); only the provider, `.code`, `.status` and the
 *   externalId are logged.
 */
export async function reconcilePendingCharges(
  opts: { limit?: number; now?: Date } = {},
): Promise<ReconcileResult> {
  const limit = opts.limit ?? DEFAULT_RECONCILE_LIMIT;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result: ReconcileResult = { checked: 0, credited: 0, expired: 0, errors: 0 };

  await creditLocallyPaidCharges(result);

  const cutoff = new Date(now.getTime() - PENDING_CUTOFF_MS).toISOString();
  const { data: pendingRows, error: pendingError } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id, created_at, provider")
    .in("status", ["PENDING", "ACTIVE"])
    .lt("created_at", cutoff)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (pendingError) throw new Error(pendingError.message);

  const checkedIds = new Set<string>();
  for (const row of pendingRows ?? []) {
    checkedIds.add(row.id);
    result.checked += 1;
    try {
      const { outcome } = await confirmCharge(row.external_id);
      if (outcome === "credited" || outcome === "already_credited") {
        result.credited += 1;
      } else {
        await maybeExpireStaleActiveCharge(row.id, now, result);
      }
    } catch (err) {
      result.errors += 1;
      logReconcileError("error reconciling charge", err, row.external_id, row.provider);
      if (isPixNotFound(err)) {
        const ageMs = now.getTime() - new Date(row.created_at).getTime();
        if (ageMs > NOT_FOUND_FAIL_AGE_MS) {
          try {
            await markChargeFailedNotFound(row.id, row.provider, nowIso);
          } catch (markErr) {
            logReconcileError(
              "error marking not-found charge failed",
              markErr,
              row.external_id,
              row.provider,
            );
          }
        }
      }
    }
    try {
      await touchChargeUpdatedAt(row.id, nowIso);
    } catch (touchErr) {
      logReconcileError(
        "error touching charge updated_at",
        touchErr,
        row.external_id,
        row.provider,
      );
    }
  }

  await recheckTerminalUncreditedCharges(result, now, nowIso, checkedIds);

  return result;
}
