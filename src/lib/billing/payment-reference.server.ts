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
    .from<{ external_id: string; last_provider_payload: Json | null }>("payment_charges")
    .select("external_id,last_provider_payload")
    .eq("id", paymentChargeId)
    .maybeSingle();
  if (chargeError) throw new Error(chargeError.message);

  const payload = chargeRow?.last_provider_payload as { endToEndId?: unknown } | null;
  const endToEnd = payload && typeof payload.endToEndId === "string" ? payload.endToEndId : null;
  return endToEnd ?? chargeRow?.external_id ?? null;
}
