// Confirms and records Upper Pix charge state (server-only). The webhook
// (src/routes/api/public/upper/webhook.ts) and the reconciliation cron
// (Task 5) both call `confirmChargeFromUpper`; crediting is only ever done
// through `billing_credit_paid_charge` (service_role RPC, Task 1), after a
// `getUpperCharge` confirms `status = 'PAID'` with a matching paid amount —
// the webhook itself is just a hint to go check, never a source of truth.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

import { maskPayerDocument } from "./payer";
import { getUpperCharge, type UpperCharge } from "./upper-pix.server";

export type ConfirmChargeOutcome =
  | "credited"
  | "already_credited"
  | "not_paid"
  | "needs_review"
  | "unknown_charge";

const TERMINAL_UNPAID_STATUSES = new Set(["EXPIRED", "CANCELLED", "FAILED"]);

/**
 * `upper.raw` is the provider's raw response, stored for superadmin
 * diagnostics only (`payment_charges.last_provider_payload`). It must NEVER
 * carry the full payer document (LGPD) — this replaces `payer.document`
 * with the masked value before it is written anywhere.
 */
function sanitizeProviderPayload(raw: unknown): Json {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "payer" in (raw as object)) {
    const record = raw as Record<string, unknown>;
    const payer = record.payer;
    if (payer && typeof payer === "object" && "document" in (payer as object)) {
      const payerRecord = payer as Record<string, unknown>;
      const document = typeof payerRecord.document === "string" ? payerRecord.document : null;
      return {
        ...record,
        payer: { ...payerRecord, document: maskPayerDocument(document) },
      } as Json;
    }
  }
  return raw as Json;
}

/**
 * Writes the latest known state of a charge from the Upper API. Sets
 * `needs_review` when the charge is reported PAID but the paid amount does
 * not match what was charged — never clears a review flag on its own (only
 * the superadmin resolving it, out of scope here, would do that). For a
 * terminal unpaid status (EXPIRED/CANCELLED/FAILED), also marks the linked
 * credit_topup_orders row with the matching lowercase status.
 */
export async function recordChargeSnapshot(chargeId: string, upper: UpperCharge): Promise<void> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("payment_charges")
    .select("ref_id, kind")
    .eq("id", chargeId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new Error("charge_not_found");

  type PaymentChargeUpdate = Database["public"]["Tables"]["payment_charges"]["Update"];
  const patch: PaymentChargeUpdate = {
    status: upper.status,
    paid_amount_cents: upper.paidAmountCents,
    paid_at: upper.paidAt,
    payer_name: upper.payer?.name ?? null,
    payer_document_masked: maskPayerDocument(upper.payer?.document ?? null),
    last_provider_payload: sanitizeProviderPayload(upper.raw),
    updated_at: new Date().toISOString(),
  };

  if (upper.status === "PAID") {
    patch.needs_review =
      upper.paidAmountCents === null || upper.paidAmountCents !== upper.amountCents;
  }

  const { error: updateError } = await supabaseAdmin
    .from("payment_charges")
    .update(patch)
    .eq("id", chargeId);
  if (updateError) throw new Error(updateError.message);

  if (TERMINAL_UNPAID_STATUSES.has(upper.status) && existing.kind === "credit_topup") {
    const { error: orderError } = await supabaseAdmin
      .from("credit_topup_orders")
      .update({ status: upper.status.toLowerCase() })
      .eq("id", existing.ref_id);
    if (orderError) throw new Error(orderError.message);
  }
}

type BillingCreditPaidChargeResult = {
  ok: boolean;
  idempotent?: boolean;
  reason?: "not_paid" | "needs_review" | "amount_mismatch";
};

/**
 * The only place that turns an Upper webhook/cron hint into an actual
 * credit. Always re-fetches the charge from Upper first (never trusts the
 * webhook payload's own numbers) and only calls the crediting RPC when that
 * fresh read says PAID with a matching paid amount.
 */
export async function confirmChargeFromUpper(
  externalId: string,
): Promise<{ outcome: ConfirmChargeOutcome }> {
  const { data: chargeRow, error: findError } = await supabaseAdmin
    .from("payment_charges")
    .select("id")
    .eq("external_id", externalId)
    .maybeSingle();
  if (findError) throw new Error(findError.message);
  if (!chargeRow) return { outcome: "unknown_charge" };

  const upper = await getUpperCharge(externalId);
  await recordChargeSnapshot(chargeRow.id, upper);

  if (upper.status !== "PAID") return { outcome: "not_paid" };

  if (upper.paidAmountCents === null || upper.paidAmountCents !== upper.amountCents) {
    return { outcome: "needs_review" };
  }

  const { data, error } = await supabaseAdmin.rpc("billing_credit_paid_charge", {
    _charge_id: chargeRow.id,
  });
  if (error) throw new Error(error.message);

  const result = data as BillingCreditPaidChargeResult | null;
  if (result?.ok) {
    return { outcome: result.idempotent ? "already_credited" : "credited" };
  }
  if (result?.reason === "needs_review" || result?.reason === "amount_mismatch") {
    return { outcome: "needs_review" };
  }
  return { outcome: "not_paid" };
}
