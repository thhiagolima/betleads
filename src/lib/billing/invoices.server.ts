// Hourly billing cycle and Pix payment of a monthly invoice (Task 3).
// `runBillingCycle` is the hourly job: generate due invoices (flag-gated),
// refresh every non-exempt house's access state (always), then notify the
// Task 5 e-mail pipeline about what was issued. `createInvoicePayment`
// mirrors the top-up flow (topup.functions.ts) for a `billing_invoices` row
// instead of a `credit_topup_orders` one; `cancelOpenInvoiceCharges` is used
// by the superadmin discount/cancel actions (Task 8) to release any open Pix
// before changing the invoice.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { recordChargeSnapshot } from "./payment-charges.server";
import { truncateDescription } from "./topup";
import { cancelUpperCharge, createUpperCharge, UpperError, type UpperCharge } from "./upper-pix.server";

const GENERIC_UPPER_FAILURE_MESSAGE =
  "Não foi possível gerar o Pix agora. Tente de novo em instantes.";
const PIX_UNAVAILABLE_MESSAGE = "Pagamento por Pix indisponível no momento.";
const INVOICE_ALREADY_PAID_MESSAGE = "Esta fatura já está paga.";
const INVOICE_NOT_FOUND_MESSAGE = "Fatura não encontrada.";

const MIN_EXPIRES_IN_SECONDS = 3600;
const MAX_EXPIRES_IN_SECONDS = 604800;
/** A reusable ACTIVE charge must still have more than this left before expiry. */
const REUSE_MIN_REMAINING_MS = 5 * 60_000;
const MAX_EXTERNAL_ID_RETRIES = 2;

type LooseRow = Record<string, unknown>;

export function isBillingInvoicesEnabled(): boolean {
  return process.env.BILLING_INVOICES_ENABLED === "true";
}

function isUpperConfigured(): boolean {
  return Boolean(process.env.UPPER_API_KEY?.trim());
}

/** Code+status only, never the raw response body (LGPD/secrets concern). */
function upperErrorSummary(error: UpperError): string {
  return `${error.code ?? "UNKNOWN"} (${error.status})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Adds `days` calendar days to a YYYY-MM-DD date string, in UTC (date-only, no TZ ambiguity). */
function addDays(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** 23:59:59 Brasília of a YYYY-MM-DD date string, as a UTC instant. */
function brasiliaDayEnd(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  // 23:59:59 BRT (UTC-3) = 02:59:59 UTC of the next day.
  return new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1, 2, 59, 59, 0));
}

/**
 * Validity window (seconds) for the invoice's Pix: from `now` until 23:59:59
 * Brasília of `due_date + 3`, clamped to [3600, 604800]. A locked house
 * paying late (that instant already past) gets the floor, 3600 — the clamp
 * on a non-positive/too-small raw value already produces that.
 */
export function computeInvoiceExpiresIn(dueDate: string, now: Date): number {
  const windowEnd = brasiliaDayEnd(addDays(dueDate, 3));
  const rawSeconds = Math.floor((windowEnd.getTime() - now.getTime()) / 1000);
  return Math.min(MAX_EXPIRES_IN_SECONDS, Math.max(MIN_EXPIRES_IN_SECONDS, rawSeconds));
}

/** "<Nome da casa> - Mensalidade BetLeads MM/AAAA", cut per `truncateDescription`. */
function invoiceDescription(tenantName: string, cycleDueDate: string): string {
  const [year, month] = cycleDueDate.split("-");
  const suffix = ` - Mensalidade BetLeads ${month}/${year}`;
  return truncateDescription(tenantName, suffix);
}

// ---------------------------------------------------------------------------
// runBillingCycle
// ---------------------------------------------------------------------------

export type BillingCycleEvents = { issuedInvoiceIds: string[] };

export type RunBillingCycleOptions = {
  now?: Date;
  sendEmails?: (events: BillingCycleEvents) => Promise<void>;
};

export type RunBillingCycleResult = {
  generated: number;
  refreshed: number;
  emails: number;
  errors: number;
};

/** Every house not already marked `exempt` locally. */
async function listNonExemptTenantIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("tenant_billing")
    .select("tenant_id")
    .neq("access_state", "exempt");
  if (error) throw new Error(error.message);
  return ((data ?? []) as LooseRow[]).map((row) => row.tenant_id as string);
}

/**
 * Refreshes one house's access state. Never throws — a failure is logged and
 * counted so one bad house never stops the rest of the loop (ruling 5).
 */
async function refreshOneTenant(tenantId: string, counters: { refreshed: number; errors: number }) {
  try {
    const { error } = await supabaseAdmin.rpc("billing_refresh_access_state", {
      _tenant: tenantId,
    });
    if (error) throw new Error(error.message);
    counters.refreshed += 1;
  } catch (err) {
    counters.errors += 1;
    console.error("[billing/invoices] refresh access state failed", {
      tenantId,
      error: errorMessage(err),
    });
  }
}

/**
 * Hourly billing job (Task 3). Sequence: generate due invoices (only when
 * `BILLING_INVOICES_ENABLED === "true"`) → refresh every non-exempt house's
 * access state (always, flag or not) → notify `sendEmails` (Task 5) about
 * what was issued, also flag-gated. `sendEmails` defaults to a no-op until
 * Task 5 wires the real e-mail pipeline.
 */
export async function runBillingCycle(
  opts: RunBillingCycleOptions = {},
): Promise<RunBillingCycleResult> {
  const sendEmails = opts.sendEmails ?? (async () => undefined);
  const counters = { refreshed: 0, errors: 0 };
  let issuedInvoiceIds: string[] = [];

  if (isBillingInvoicesEnabled()) {
    const { data, error } = await supabaseAdmin.rpc("billing_generate_due_invoices", {});
    if (error) throw new Error(error.message);
    issuedInvoiceIds = ((data ?? []) as unknown[]).map((id) => String(id));
  }

  const tenantIds = await listNonExemptTenantIds();
  for (const tenantId of tenantIds) {
    await refreshOneTenant(tenantId, counters);
  }

  let emails = 0;
  if (isBillingInvoicesEnabled()) {
    await sendEmails({ issuedInvoiceIds });
    emails = issuedInvoiceIds.length;
  }

  return {
    generated: issuedInvoiceIds.length,
    refreshed: counters.refreshed,
    emails,
    errors: counters.errors,
  };
}

// ---------------------------------------------------------------------------
// createInvoicePayment
// ---------------------------------------------------------------------------

export type CreateInvoicePaymentResult = {
  chargeId: string;
  emv: string | null;
  qrCodeImage: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  amountCents: number;
};

type InvoiceRow = {
  id: string;
  tenant_id: string;
  status: string;
  amount_cents: number;
  due_date: string;
  cycle_due_date: string;
};

async function getOpenInvoiceOrThrow(invoiceId: string): Promise<InvoiceRow> {
  const { data, error } = await supabaseAdmin
    .from("billing_invoices")
    .select("id, tenant_id, status, amount_cents, due_date, cycle_due_date")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const invoice = data as InvoiceRow | null;
  if (!invoice) throw new Error(INVOICE_NOT_FOUND_MESSAGE);
  if (invoice.status === "paid") throw new Error(INVOICE_ALREADY_PAID_MESSAGE);
  if (invoice.status !== "open") throw new Error(INVOICE_NOT_FOUND_MESSAGE);
  return invoice;
}

async function getTenantName(tenantId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("nome")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { nome: string | null } | null)?.nome ?? "";
}

/** A still-payable ACTIVE charge of the exact same amount, with >5 min left. */
async function findReusableActiveCharge(
  invoiceId: string,
  amountCents: number,
  now: Date,
): Promise<LooseRow | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, emv, qr_code_image, payment_url, expires_at, amount_cents")
    .eq("kind", "invoice")
    .eq("ref_id", invoiceId)
    .eq("status", "ACTIVE")
    .eq("amount_cents", amountCents)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const candidate = ((data ?? []) as LooseRow[]).find((row) => {
    const expiresAt = row.expires_at as string | null;
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() - now.getTime() > REUSE_MIN_REMAINING_MS;
  });
  return candidate ?? null;
}

async function nextChargeSequence(invoiceId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id")
    .eq("kind", "invoice")
    .eq("ref_id", invoiceId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LooseRow[]).length + 1;
}

function isUniqueConflict(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key/i.test(error.message ?? "");
}

/** Inserts the PENDING charge row for one attempt; null on a unique conflict. */
async function insertPendingCharge(input: {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  externalId: string;
  actorUserId: string;
}): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .insert({
      tenant_id: input.tenantId,
      kind: "invoice",
      ref_id: input.invoiceId,
      provider: "upper",
      external_id: input.externalId,
      status: "PENDING",
      amount_cents: input.amountCents,
      created_by: input.actorUserId,
    })
    .select("id")
    .single();
  if (error) {
    if (isUniqueConflict(error)) return null;
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}

async function markChargeFailed(chargeId: string, summary: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payment_charges")
    .update({ status: "FAILED", last_error: summary, updated_at: new Date().toISOString() })
    .eq("id", chargeId);
  if (error) console.error("[billing/invoices] mark charge FAILED failed:", error.message);
}

/**
 * Pix payment of an open invoice (Task 3; payer/tenant authorization is
 * Task 7's job — this only asserts the invoice is open and the gateway is
 * on). Reuses a still-valid ACTIVE charge of the exact amount when one
 * exists; otherwise inserts a new `bl-inv-<id>-<n>` charge (n = 1 + the
 * count of existing charges for the invoice) and asks Upper for a Pix,
 * exactly like `createCreditTopupFor` (topup.functions.ts) does for a
 * top-up order. A unique `external_id` conflict (another request racing the
 * same `n`) retries once with `n+1`.
 */
export async function createInvoicePayment(
  invoiceId: string,
  actorUserId: string,
): Promise<CreateInvoicePaymentResult> {
  if (!isBillingInvoicesEnabled() || !isUpperConfigured()) {
    throw new Error(PIX_UNAVAILABLE_MESSAGE);
  }

  const invoice = await getOpenInvoiceOrThrow(invoiceId);

  const now = new Date();
  const reusable = await findReusableActiveCharge(invoice.id, invoice.amount_cents, now);
  if (reusable) {
    return {
      chargeId: reusable.id as string,
      emv: (reusable.emv as string | null) ?? null,
      qrCodeImage: (reusable.qr_code_image as string | null) ?? null,
      paymentUrl: (reusable.payment_url as string | null) ?? null,
      expiresAt: (reusable.expires_at as string | null) ?? null,
      amountCents: reusable.amount_cents as number,
    };
  }

  const tenantName = await getTenantName(invoice.tenant_id);
  const description = invoiceDescription(tenantName, invoice.cycle_due_date);
  const expiresIn = computeInvoiceExpiresIn(invoice.due_date, now);

  let n = await nextChargeSequence(invoice.id);
  let chargeId: string | null = null;
  let externalId = "";
  for (let attempt = 0; attempt <= MAX_EXTERNAL_ID_RETRIES; attempt += 1) {
    externalId = `bl-inv-${invoice.id}-${n}`;
    chargeId = await insertPendingCharge({
      tenantId: invoice.tenant_id,
      invoiceId: invoice.id,
      amountCents: invoice.amount_cents,
      externalId,
      actorUserId,
    });
    if (chargeId) break;
    n += 1;
  }
  if (!chargeId) throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);

  let upper: UpperCharge;
  try {
    upper = await createUpperCharge({
      amountCents: invoice.amount_cents,
      description,
      externalId,
      expiresIn,
      metadata: { tenantId: invoice.tenant_id, kind: "invoice", refId: invoice.id },
    });
  } catch (error) {
    const summary = error instanceof UpperError ? upperErrorSummary(error) : "UNKNOWN_ERROR (0)";
    await markChargeFailed(chargeId, summary);
    throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
  }

  await recordChargeSnapshot(chargeId, upper);

  return {
    chargeId,
    emv: upper.emv,
    qrCodeImage: upper.qrCodeImage,
    paymentUrl: upper.paymentUrl,
    expiresAt: upper.expiresAt,
    amountCents: invoice.amount_cents,
  };
}

// ---------------------------------------------------------------------------
// cancelOpenInvoiceCharges
// ---------------------------------------------------------------------------

/**
 * Cancels every still-open (PENDING/ACTIVE) Pix charge of an invoice at
 * Upper and records it CANCELLED, through the same `recordChargeSnapshot`
 * path used everywhere else a charge's state changes. Used by the
 * superadmin discount and cancel actions (Task 8) before changing an
 * invoice that may already have an open Pix out. One charge failing to
 * cancel at Upper is logged and never stops the others.
 */
export async function cancelOpenInvoiceCharges(invoiceId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id")
    .eq("kind", "invoice")
    .eq("ref_id", invoiceId)
    .in("status", ["PENDING", "ACTIVE"]);
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as LooseRow[]) {
    const chargeId = row.id as string;
    const externalId = row.external_id as string;
    try {
      const upper = await cancelUpperCharge(externalId);
      await recordChargeSnapshot(chargeId, upper);
    } catch (err) {
      console.error("[billing/invoices] cancelOpenInvoiceCharges failed", {
        chargeId,
        error: errorMessage(err),
      });
    }
  }
}
