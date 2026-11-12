// Shared helper (PG3 Task 9): the receipt code shown to a house for a paid
// invoice — the Pix endToEndId when we have one, else the charge's
// `external_id`, else null (manual settle, no payment_charge_id at all).
// Used by `getInvoiceReceiptFor` (billing.functions.ts) and by the `paid`
// billing e-mail (billing-emails.server.ts), which falls back to "Baixa
// manual" when this comes back null.

import type { Json } from "@/integrations/supabase/types";

type DbError = { message: string };
type DbResult<T> = { data: T | null; error: DbError | null };
type LooseQuery<T> = Promise<DbResult<T>> & {
  select: (columns: string) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  maybeSingle: () => Promise<DbResult<T>>;
};
type LooseSupabase = {
  from: <T>(table: string) => LooseQuery<T>;
};

const SPACEPAY_END_TO_END_KEYS = ["endToEndId", "end_to_end_id", "e2eId", "end2end"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Upper puts `endToEndId` at the top level of its charge payload. */
function upperEndToEnd(payload: unknown): string | null {
  return isRecord(payload) ? nonEmptyString(payload.endToEndId) : null;
}

/**
 * SpacePay: the stored payload is the allow-listed snapshot built by
 * spacepay-pix.server, which already extracted the end-to-end id into a
 * top-level `endToEndId`. Rows stored before that allow-list still carry the
 * full body, so the old `data.history[].payload` scan (latest entry first)
 * stays as a fallback. None → null (caller falls back to external_id).
 */
function spacePayEndToEnd(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const extracted = nonEmptyString(payload.endToEndId);
  if (extracted) return extracted;
  const data = isRecord(payload.data) ? payload.data : payload;
  const history = Array.isArray(data.history) ? data.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const entryPayload = isRecord(entry) ? entry.payload : null;
    if (!isRecord(entryPayload)) continue;
    for (const key of SPACEPAY_END_TO_END_KEYS) {
      const value = nonEmptyString(entryPayload[key]);
      if (value) return value;
    }
  }
  return null;
}

/** End-to-end id from a charge's stored gateway payload, by the charge's own provider. */
export function endToEndFromPayload(provider: string | null | undefined, payload: unknown): string | null {
  if (provider === "spacepay") return spacePayEndToEnd(payload);
  return upperEndToEnd(payload);
}

/**
 * Looks up the endToEndId (or `external_id` if the payload has no
 * endToEndId) of the Pix charge linked to an invoice. Returns null when
 * there is no linked charge (manual settle) or no charge row is found.
 */
export async function getEndToEndOrExternalId(
  db: unknown,
  paymentChargeId: string | null,
): Promise<string | null> {
  if (!paymentChargeId) return null;

  const client = db as LooseSupabase;
  const { data: chargeRow, error: chargeError } = await client
    .from<{
      external_id: string;
      provider: string | null;
      last_provider_payload: Json | null;
    }>("payment_charges")
    .select("external_id,provider,last_provider_payload")
    .eq("id", paymentChargeId)
    .maybeSingle();
  if (chargeError) throw new Error(chargeError.message);

  const endToEnd = endToEndFromPayload(chargeRow?.provider, chargeRow?.last_provider_payload);
  return endToEnd ?? chargeRow?.external_id ?? null;
}
