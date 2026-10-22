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
/** Another request is already creating this invoice's one allowed open charge. */
const GENERATING_MESSAGE = "Gerando o Pix, tente de novo em instantes.";

const MIN_EXPIRES_IN_SECONDS = 3600;
const MAX_EXPIRES_IN_SECONDS = 604800;
/** A reusable ACTIVE charge must still have more than this left before expiry. */
const REUSE_MIN_REMAINING_MS = 5 * 60_000;
/**
 * Fix round 1: at most one retry, and only for an `external_id` collision
 * with a leftover terminal-status row (same invoice, an old sequence
 * number). A collision with `payment_charges_one_open_per_invoice` (the
 * partial unique index added in 20261023100000_billing_invoices.sql) is
 * never retried here — see `handleOpenChargeRace`.
 */
const MAX_EXTERNAL_ID_RETRIES = 1;
/** PostgREST's default page cap; `listNonExemptTenantIds` pages past it. */
const LIST_PAGE_SIZE = 1000;

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
  /**
   * Task 5's e-mail pipeline. Wired by the cron route to
   * `sendPendingBillingEmails` (billing-emails.server.ts); defaults to a
   * no-op here so this module never depends on it directly. When it returns
   * a number, that is the real count of e-mails sent and becomes
   * `RunBillingCycleResult.issued`; a callback that returns nothing (the
   * default, and every existing test double) falls back to
   * `issuedInvoiceIds.length`, same as before this task.
   */
  sendEmails?: (events: BillingCycleEvents) => Promise<number | void>;
};

export type RunBillingCycleResult = {
  generated: number;
  refreshed: number;
  /**
   * The real count of e-mails `sendEmails` reports as sent this run, when
   * the cron route wires it to `sendPendingBillingEmails` (Task 5). A
   * `sendEmails` that returns nothing (the default no-op, and existing test
   * doubles) falls back to `generated` — "how many invoices were handed to
   * the callback" — so this never regresses callers that do not inject a
   * counting callback.
   */
  issued: number;
  errors: number;
  /**
   * One line per failed stage of the run (generation, house listing), e.g.
   * `"list_tenants: timeout"`. A failed stage never stops the later ones:
   * the e-mail sweep runs even if the house list could not be read.
   */
  failures: string[];
};

/**
 * Every house not already marked `exempt` locally, paged past PostgREST's
 * default 1000-row cap (`.range`) so a house list past that size is never
 * silently truncated — a truncated page would mean the tail of the house
 * list never gets its access_state refreshed on some runs.
 */
async function listNonExemptTenantIds(): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  // Sanity guard against an infinite loop if `.range()` is ever ignored by
  // a stub/mock and every page comes back full — same convention as
  // sms.functions.ts's paging loops.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const { data, error } = await supabaseAdmin
      .from("tenant_billing")
      .select("tenant_id")
      .neq("access_state", "exempt")
      .order("tenant_id", { ascending: true })
      .range(offset, offset + LIST_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as LooseRow[];
    for (const row of page) ids.push(row.tenant_id as string);
    if (page.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return ids;
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
 * access state (always, flag or not, and even if generation itself failed —
 * ruling: refresh always happens) → notify `sendEmails` (Task 5) about what
 * was issued, also flag-gated. `sendEmails` defaults to a no-op until Task 5
 * wires the real e-mail pipeline.
 */
export async function runBillingCycle(
  opts: RunBillingCycleOptions = {},
): Promise<RunBillingCycleResult> {
  const sendEmails = opts.sendEmails ?? (async () => undefined);
  const counters = { refreshed: 0, errors: 0 };
  const failures: string[] = [];
  let issuedInvoiceIds: string[] = [];

  if (isBillingInvoicesEnabled()) {
    try {
      const { data, error } = await supabaseAdmin.rpc("billing_generate_due_invoices", {});
      if (error) throw new Error(error.message);
      issuedInvoiceIds = ((data ?? []) as unknown[]).map((id) => String(id));
    } catch (err) {
      counters.errors += 1;
      failures.push(`generate: ${errorMessage(err)}`);
      console.error("[billing/invoices] billing_generate_due_invoices failed", {
        error: errorMessage(err),
      });
      // issuedInvoiceIds stays []: the refresh loop below still runs for
      // every house, generated or not.
    }
  }

  // A failed house listing skips only the refresh: the e-mail sweep below
  // still runs (it reads its own candidates from the DB).
  let tenantIds: string[] = [];
  try {
    tenantIds = await listNonExemptTenantIds();
  } catch (err) {
    counters.errors += 1;
    failures.push(`list_tenants: ${errorMessage(err)}`);
    console.error("[billing/invoices] listing non-exempt houses failed", {
      error: errorMessage(err),
    });
  }
  for (const tenantId of tenantIds) {
    await refreshOneTenant(tenantId, counters);
  }

  let issued = 0;
  if (isBillingInvoicesEnabled()) {
    const sent = await sendEmails({ issuedInvoiceIds });
    issued = typeof sent === "number" ? sent : issuedInvoiceIds.length;
  }

  return {
    generated: issuedInvoiceIds.length,
    refreshed: counters.refreshed,
    issued,
    errors: counters.errors,
    failures,
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

type OpenChargeRow = {
  id: string;
  external_id: string;
  status: string;
  amount_cents: number;
  emv: string | null;
  qr_code_image: string | null;
  payment_url: string | null;
  expires_at: string | null;
};

/**
 * The invoice's one still-open (PENDING/ACTIVE) charge, if any —
 * `payment_charges_one_open_per_invoice` (20261023100000_billing_invoices.sql)
 * guarantees there is at most one once this migration is applied.
 */
async function findOpenCharge(invoiceId: string): Promise<OpenChargeRow | null> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id, status, amount_cents, emv, qr_code_image, payment_url, expires_at")
    .eq("kind", "invoice")
    .eq("ref_id", invoiceId)
    .in("status", ["PENDING", "ACTIVE"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OpenChargeRow | null) ?? null;
}

/** ACTIVE, the exact invoice amount, and more than 5 min left before expiry. */
function isReusable(charge: OpenChargeRow, amountCents: number, now: Date): boolean {
  if (charge.status !== "ACTIVE") return false;
  if (charge.amount_cents !== amountCents) return false;
  if (!charge.expires_at) return false;
  return new Date(charge.expires_at).getTime() - now.getTime() > REUSE_MIN_REMAINING_MS;
}

function chargeResult(charge: OpenChargeRow): CreateInvoicePaymentResult {
  return {
    chargeId: charge.id,
    emv: charge.emv,
    qrCodeImage: charge.qr_code_image,
    paymentUrl: charge.payment_url,
    expiresAt: charge.expires_at,
    amountCents: charge.amount_cents,
  };
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

type InsertChargeResult =
  | { ok: true; id: string }
  | { ok: false; reason: "external_id" | "open_charge" };

/**
 * Inserts the PENDING charge row for one attempt. On a unique-constraint
 * conflict, distinguishes which invariant tripped by re-reading whether a
 * row with this exact `external_id` already exists:
 * - it does → our own sequence number `n` collided with a leftover
 *   terminal-status charge (same invoice, an old attempt); the caller bumps
 *   `n` and retries (at most once);
 * - it doesn't → a concurrent request already won the race and created the
 *   invoice's one allowed open charge
 *   (`payment_charges_one_open_per_invoice`); the caller never retries this,
 *   it re-reads that charge instead (`handleOpenChargeRace`).
 */
async function insertPendingCharge(input: {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  externalId: string;
  actorUserId: string;
}): Promise<InsertChargeResult> {
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
  if (!error) return { ok: true, id: (data as { id: string }).id };
  if (!isUniqueConflict(error)) throw new Error(error.message);

  const { data: collision, error: lookupError } = await supabaseAdmin
    .from("payment_charges")
    .select("id")
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  return { ok: false, reason: collision ? "external_id" : "open_charge" };
}

async function markChargeFailed(chargeId: string, summary: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payment_charges")
    .update({ status: "FAILED", last_error: summary, updated_at: new Date().toISOString() })
    .eq("id", chargeId);
  if (error) console.error("[billing/invoices] mark charge FAILED failed:", error.message);
}

/**
 * Lost the race to create the invoice's one open charge
 * (`payment_charges_one_open_per_invoice` conflict on insert): re-reads it
 * and resolves exactly like the pre-insert check does — reusable → return
 * it; still `PENDING` → tell the caller to retry shortly; anything else
 * (amount mismatch, ACTIVE near expiry) → the generic failure message. Never
 * creates a second charge here.
 */
async function handleOpenChargeRace(
  invoice: InvoiceRow,
  now: Date,
): Promise<CreateInvoicePaymentResult> {
  const openCharge = await findOpenCharge(invoice.id);
  if (openCharge && isReusable(openCharge, invoice.amount_cents, now)) {
    return chargeResult(openCharge);
  }
  if (openCharge && openCharge.status === "PENDING") {
    throw new Error(GENERATING_MESSAGE);
  }
  throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
}

/**
 * Pix payment of an open invoice (Task 3; payer/tenant authorization is
 * Task 7's job — this only asserts the invoice is open and the gateway is
 * on). At most one still-payable Pix charge exists per invoice at any time
 * (enforced in the DB by `payment_charges_one_open_per_invoice`, fix round
 * 1): a reusable ACTIVE charge of the exact amount is returned as-is; an
 * open charge of a STALE amount (the invoice was repriced after the charge
 * was created) is canceled first (`cancelOpenInvoiceCharges` semantics)
 * before a new one is created; an open charge of the current amount that
 * isn't reusable (still `PENDING`, or ACTIVE but near expiry) is left alone
 * — the caller is told to wait rather than getting a second Pix. Creating a
 * genuinely new charge follows `createCreditTopupFor`'s pattern
 * (topup.functions.ts): insert `PENDING` before calling Upper, `FAILED`
 * with the generic message on an Upper failure. A unique `external_id`
 * conflict (an old attempt's row, never the open-charge index) retries once
 * with `n+1`; a conflict with the open-charge index itself never retries —
 * see `handleOpenChargeRace`.
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

  const openCharge = await findOpenCharge(invoice.id);
  if (openCharge) {
    if (isReusable(openCharge, invoice.amount_cents, now)) {
      return chargeResult(openCharge);
    }
    if (openCharge.amount_cents !== invoice.amount_cents) {
      // The invoice was repriced after this charge was created: it can
      // never be paid for the right amount, so release it before creating
      // a fresh one for the current amount.
      await cancelOpenInvoiceCharges(invoice.id);
    } else if (openCharge.status === "PENDING") {
      // Same amount, still being created (by this request's own earlier
      // attempt or a concurrent one) — never pile a second charge on top.
      throw new Error(GENERATING_MESSAGE);
    } else {
      // ACTIVE, same amount, but <=5 min left: let it run its course
      // (expire/reconcile) instead of creating a duplicate open charge.
      throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
    }
  }

  const tenantName = await getTenantName(invoice.tenant_id);
  const description = invoiceDescription(tenantName, invoice.cycle_due_date);
  const expiresIn = computeInvoiceExpiresIn(invoice.due_date, now);

  let n = await nextChargeSequence(invoice.id);
  let chargeId: string | null = null;
  let externalId = "";
  for (let attempt = 0; ; attempt += 1) {
    externalId = `bl-inv-${invoice.id}-${n}`;
    const result = await insertPendingCharge({
      tenantId: invoice.tenant_id,
      invoiceId: invoice.id,
      amountCents: invoice.amount_cents,
      externalId,
      actorUserId,
    });
    if (result.ok) {
      chargeId = result.id;
      break;
    }
    if (result.reason === "open_charge") {
      return await handleOpenChargeRace(invoice, now);
    }
    if (attempt >= MAX_EXTERNAL_ID_RETRIES) throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
    n += 1;
  }

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

/** Per-charge Upper cancel failure, reported back so callers can audit it truthfully. */
export type CancelOpenInvoiceChargesFailure = { chargeId: string; error: string };

export type CancelOpenInvoiceChargesResult = {
  canceled: number;
  failed: CancelOpenInvoiceChargesFailure[];
};

/**
 * Cancels every still-open (PENDING/ACTIVE) Pix charge of an invoice at
 * Upper and records it CANCELLED, through the same `recordChargeSnapshot`
 * path used everywhere else a charge's state changes. Used by the
 * superadmin discount and cancel actions (Task 8) before changing an
 * invoice that may already have an open Pix out. One charge failing to
 * cancel at Upper is logged and never stops the others, but it is reported
 * back in `failed` (fix round 1, I1) so a caller auditing this action does
 * not claim success when Upper actually rejected the cancel.
 */
export async function cancelOpenInvoiceCharges(
  invoiceId: string,
): Promise<CancelOpenInvoiceChargesResult> {
  const { data, error } = await supabaseAdmin
    .from("payment_charges")
    .select("id, external_id")
    .eq("kind", "invoice")
    .eq("ref_id", invoiceId)
    .in("status", ["PENDING", "ACTIVE"]);
  if (error) throw new Error(error.message);

  let canceled = 0;
  const failed: CancelOpenInvoiceChargesFailure[] = [];
  for (const row of (data ?? []) as LooseRow[]) {
    const chargeId = row.id as string;
    const externalId = row.external_id as string;
    try {
      const upper = await cancelUpperCharge(externalId);
      await recordChargeSnapshot(chargeId, upper);
      canceled += 1;
    } catch (err) {
      const message = errorMessage(err);
      console.error("[billing/invoices] cancelOpenInvoiceCharges failed", {
        chargeId,
        error: message,
      });
      failed.push({ chargeId, error: message });
    }
  }
  return { canceled, failed };
}
