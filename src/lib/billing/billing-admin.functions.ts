// Task 8 — super admin billing console (server side): block/extend/free-days,
// discounts, manual settle/cancel, cycle/plan actions, resend e-mail, Pix fee
// registration, and the three read screens (dashboard, per-tenant history,
// monthly CSV).
//
// Every write action here:
// - requires the super admin (checked twice: once in TS via `is_super_admin`,
//   once again inside the SQL action itself);
// - requires a reason of 5+ characters, validated by zod on every input and
//   recorded in the audit row's metadata;
// - calls the SQL `billing_admin_*` RPC (Task 2) through `ctx.supabase` (the
//   CALLER's client), never `supabaseAdmin` — those functions check
//   `is_super_admin()`, which reads `auth.uid()`, null on the service-role
//   client, so calling them through `supabaseAdmin` always fails with
//   `forbidden`. This was a real production bug in PG1: never repeat it.
// - writes one `tenant_audit_logs` row with `action = "billing.<ação>"`.
//
// Repricing a house with an open Pix out (continuous discount, custom price,
// freezing) and the one-off discount/cancel actions must cancel that Pix at
// Upper first (`cancelOpenInvoiceCharges`, Task 3) so the next GET/webhook
// never confirms a charge for an amount that no longer matches the invoice.
// That cancel is best-effort: a failure at Upper is logged in the audit
// metadata but never blocks the SQL action (the invoice row is the source of
// truth; a stuck Pix at Upper just expires unused).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { neutralizeCsvFormula } from "@/lib/csv-safe";
import { selectAllPages } from "@/lib/pagination";
import { listDemoTenantIds } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

import { cancelOpenInvoiceCharges, type CancelOpenInvoiceChargesFailure } from "./invoices.server";
import { sendBillingEmail, type BillingEmailKind } from "./billing-emails.server";
import { brtDayKey, parseBrtDayStart } from "../tz";

// ---------------------------------------------------------------------------
// Loose Supabase helpers (same pattern as sms-credits.functions.ts /
// billing.functions.ts: the real client is typed generically by Supabase
// codegen, these just give us the handful of builder methods this file uses).
// ---------------------------------------------------------------------------

type ServerContext = {
  // The per-request, user-scoped client (never supabaseAdmin) for RPCs that
  // check is_super_admin() with no service_role bypass.
  supabase: unknown;
  userId: string;
};

type DbError = { message: string; details?: string | null };
type DbResult<T = unknown> = { data: T | null; error: DbError | null; count?: number | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string, options?: { count?: "exact"; head?: boolean }) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  in: (column: string, values: unknown[]) => LooseQuery<T>;
  not: (column: string, operator: string, value: unknown) => LooseQuery<T>;
  is: (column: string, value: unknown) => LooseQuery<T>;
  like: (column: string, pattern: string) => LooseQuery<T>;
  gte: (column: string, value: unknown) => LooseQuery<T>;
  lt: (column: string, value: unknown) => LooseQuery<T>;
  order: (column: string, options?: { ascending?: boolean }) => LooseQuery<T>;
  limit: (count: number) => LooseQuery<T>;
  insert: (values: unknown) => Promise<DbResult>;
  maybeSingle: () => Promise<DbResult<T>>;
};
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => LooseQuery<T>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Error translation (SQL stable codes -> pt-BR text, global-constraints.md)
// ---------------------------------------------------------------------------

const PIX_MINIMUM_MESSAGE =
  "O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)";

export const BILLING_ADMIN_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Apenas o super admin pode realizar esta ação.",
  invoice_not_open: "Só faturas em aberto podem ser alteradas.",
  amount_below_pix_minimum: PIX_MINIMUM_MESSAGE,
  invalid_days: "Número de dias inválido.",
  invalid_discount: "Desconto inválido.",
  tenant_exempt: "Casas isentas não recebem ações de cobrança.",
  invoice_not_found: "Fatura não encontrada.",
  tenant_not_found: "Casa não encontrada.",
  invalid_amount: "Valor inválido.",
  invalid_date: "Data inválida.",
  invalid_via: "Forma de pagamento inválida.",
};

function translateBillingError(error: DbError): Error {
  const code = (error.message ?? "").trim();
  if (code === "amount_below_pix_minimum") {
    return new Error(error.details?.trim() || PIX_MINIMUM_MESSAGE);
  }
  const mapped = BILLING_ADMIN_ERROR_MESSAGES[code];
  return new Error(mapped ?? error.message);
}

function unwrap<T>(res: DbResult<T>): T {
  if (res.error) throw translateBillingError(res.error);
  return res.data as T;
}

/** Shape of `billing_admin_result()` (Task 2), returned by every billing_admin_* RPC. */
type BillingAdminResult = {
  ok: boolean;
  tenant_id: string;
  access_state: string;
  next_due_date: string | null;
  invoice_id?: string;
};

// ---------------------------------------------------------------------------
// Super admin + reason
// ---------------------------------------------------------------------------

async function assertSuperAdmin(userId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error(BILLING_ADMIN_ERROR_MESSAGES.forbidden);
}

const reasonSchema = z
  .string()
  .trim()
  .min(5, "O motivo deve ter ao menos 5 caracteres.");

/** Shared `YYYY-MM-DD` validator (minor m4): same shape/message everywhere a plain date string
 * comes in — `nextDueDate`, and the continuous discount's `startsOn`/`endsOn`. */
const dateStrSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.");

// ---------------------------------------------------------------------------
// Audit (tenant_audit_logs, action = "billing.<ação>")
// ---------------------------------------------------------------------------

async function auditBillingAction(args: {
  tenantId: string;
  actorUserId: string;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("tenant_audit_logs").insert({
    tenant_id: args.tenantId,
    actor_user_id: args.actorUserId,
    action: args.action,
    entity_type: "tenant_billing",
    entity_id: args.tenantId,
    metadata: { reason: args.reason, ...(args.metadata ?? {}) } as Json,
  });
  if (error) console.error("[billing-admin] failed writing audit log", error.message);
}

// ---------------------------------------------------------------------------
// Cancel open Pix before repricing (ruling 1)
// ---------------------------------------------------------------------------

async function findOpenInvoiceId(tenantId: string): Promise<string | null> {
  const { data, error } = await looseDb(supabaseAdmin)
    .from<{ id: string }>("billing_invoices")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

/** Shape folded into the audit row's `pixCancel` metadata (fix round 1, I1). */
export type PixCancelAudit = {
  attempted: boolean;
  ok: boolean;
  canceled: number;
  failed: CancelOpenInvoiceChargesFailure[];
};

/**
 * Best-effort cancel of the open invoice's Pix charges at Upper. Never
 * throws: `cancelOpenInvoiceCharges` already reports each charge's own
 * Upper failure instead of swallowing it (fix round 1, I1), so `ok` here is
 * `failed.length === 0` — true audit truth, not just "the call returned".
 * The caller proceeds with the SQL action regardless, per ruling 1 ("if the
 * Upper cancel fails, still proceed with the SQL action and record the
 * failure").
 */
async function cancelOpenPixBestEffort(invoiceId: string | null): Promise<PixCancelAudit> {
  if (!invoiceId) return { attempted: false, ok: true, canceled: 0, failed: [] };
  try {
    const { canceled, failed } = await cancelOpenInvoiceCharges(invoiceId);
    if (failed.length > 0) {
      console.error("[billing-admin] cancelOpenInvoiceCharges reported per-charge failures", failed);
    }
    return { attempted: true, ok: failed.length === 0, canceled, failed };
  } catch (err) {
    // Only reached if cancelOpenInvoiceCharges itself throws (e.g. the
    // lookup query failed), not for an individual charge's Upper rejection.
    const message = errorMessage(err);
    console.error("[billing-admin] cancelOpenInvoiceCharges failed", message);
    return { attempted: true, ok: false, canceled: 0, failed: [{ chargeId: "unknown", error: message }] };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function brlReais(reais: number): string {
  return reais.toFixed(2).replace(".", ",");
}

function formatDateBR(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function viaLabel(via: string | null): string {
  if (via === "pix") return "Pix";
  if (via === "manual") return "baixa manual";
  if (via === "full_discount") return "desconto integral";
  return via ?? "";
}

function discountCentsFor(base: number, kind: string | null, value: number | null): number {
  if (!kind || value == null) return 0;
  if (kind === "percent") return Math.min(base, Math.round((base * value) / 100));
  return Math.min(base, Math.round(value));
}

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

function nextYyyyMm(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ===========================================================================
// 1-3. Bloqueio, prazo e dias grátis
// ===========================================================================

export const adminSetTenantBlockInput = z.object({
  tenantId: dbUuid(),
  blocked: z.boolean(),
  reason: reasonSchema,
});

export async function adminSetTenantBlockFor(ctx: ServerContext, data: unknown) {
  const input = adminSetTenantBlockInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_set_block", {
      _tenant: input.tenantId,
      _blocked: input.blocked,
      _reason: input.reason,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.set_block",
    reason: input.reason,
    metadata: { blocked: input.blocked },
  });
  return result;
}

export const adminSetTenantBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetTenantBlockInput.parse(data))
  .handler(async ({ data, context }) => adminSetTenantBlockFor(context as ServerContext, data));

export const adminExtendInvoiceDueInput = z.object({
  invoiceId: dbUuid(),
  days: z.number().int().min(1).max(31),
  reason: reasonSchema,
});

export async function adminExtendInvoiceDueFor(ctx: ServerContext, data: unknown) {
  const input = adminExtendInvoiceDueInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const result = unwrap<{ tenant_id: string }>(
    await looseDb(ctx.supabase).rpc("billing_admin_extend_due", {
      _invoice: input.invoiceId,
      _days: input.days,
    }),
  );
  await auditBillingAction({
    tenantId: result.tenant_id,
    actorUserId: ctx.userId,
    action: "billing.extend_due",
    reason: input.reason,
    metadata: { invoiceId: input.invoiceId, days: input.days },
  });
  return result;
}

export const adminExtendInvoiceDue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminExtendInvoiceDueInput.parse(data))
  .handler(async ({ data, context }) => adminExtendInvoiceDueFor(context as ServerContext, data));

export const adminGrantFreeDaysInput = z.object({
  tenantId: dbUuid(),
  days: z.number().int().min(1).max(365),
  reason: reasonSchema,
});

export async function adminGrantFreeDaysFor(ctx: ServerContext, data: unknown) {
  const input = adminGrantFreeDaysInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_free_days", {
      _tenant: input.tenantId,
      _days: input.days,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.free_days",
    reason: input.reason,
    metadata: { days: input.days },
  });
  return result;
}

export const adminGrantFreeDays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminGrantFreeDaysInput.parse(data))
  .handler(async ({ data, context }) => adminGrantFreeDaysFor(context as ServerContext, data));

// ===========================================================================
// 4-5. Descontos
// ===========================================================================

const discountKind = z.enum(["percent", "fixed"]).nullable();

export const adminApplyInvoiceDiscountInput = z.object({
  invoiceId: dbUuid(),
  kind: discountKind,
  value: z.number().min(0).nullable(),
  reason: reasonSchema,
});

export async function adminApplyInvoiceDiscountFor(ctx: ServerContext, data: unknown) {
  const input = adminApplyInvoiceDiscountInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const cancel = await cancelOpenPixBestEffort(input.invoiceId);

  const result = unwrap<{ tenant_id: string }>(
    await looseDb(ctx.supabase).rpc("billing_admin_one_off_discount", {
      _invoice: input.invoiceId,
      _kind: input.kind,
      _value: input.value,
    }),
  );
  await auditBillingAction({
    tenantId: result.tenant_id,
    actorUserId: ctx.userId,
    action: "billing.apply_invoice_discount",
    reason: input.reason,
    metadata: { invoiceId: input.invoiceId, kind: input.kind, value: input.value, pixCancel: cancel },
  });
  return result;
}

export const adminApplyInvoiceDiscount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminApplyInvoiceDiscountInput.parse(data))
  .handler(async ({ data, context }) =>
    adminApplyInvoiceDiscountFor(context as ServerContext, data),
  );

export const adminSetContinuousDiscountInput = z.object({
  tenantId: dbUuid(),
  kind: discountKind,
  value: z.number().min(0).nullable(),
  startsOn: dateStrSchema.nullable().optional(),
  endsOn: dateStrSchema.nullable().optional(),
  reason: reasonSchema,
});

export async function adminSetContinuousDiscountFor(ctx: ServerContext, data: unknown) {
  const input = adminSetContinuousDiscountInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const openInvoiceId = await findOpenInvoiceId(input.tenantId);
  const cancel = await cancelOpenPixBestEffort(openInvoiceId);

  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_set_continuous_discount", {
      _tenant: input.tenantId,
      _kind: input.kind,
      _value: input.value,
      _starts: input.startsOn ?? null,
      _ends: input.endsOn ?? null,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.set_continuous_discount",
    reason: input.reason,
    metadata: {
      kind: input.kind,
      value: input.value,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      pixCancel: cancel,
    },
  });
  return result;
}

export const adminSetContinuousDiscount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetContinuousDiscountInput.parse(data))
  .handler(async ({ data, context }) =>
    adminSetContinuousDiscountFor(context as ServerContext, data),
  );

// ===========================================================================
// 6-7. Faturas: baixa manual e cancelamento
// ===========================================================================

export const adminManualSettleInput = z.object({
  invoiceId: dbUuid(),
  paidAmountCents: z.number().int().min(0).nullable().optional(),
  note: z.string().trim().min(1).max(500),
  receipt: z.string().trim().min(1).max(2000),
  reason: reasonSchema,
});

export async function adminManualSettleFor(ctx: ServerContext, data: unknown) {
  const input = adminManualSettleInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const result = unwrap<{ tenant_id: string; invoice_id: string }>(
    await looseDb(ctx.supabase).rpc("billing_admin_manual_settle", {
      _invoice: input.invoiceId,
      _paid_amount_cents: input.paidAmountCents ?? null,
      _note: input.note,
      _receipt: input.receipt,
    }),
  );
  await auditBillingAction({
    tenantId: result.tenant_id,
    actorUserId: ctx.userId,
    action: "billing.manual_settle",
    reason: input.reason,
    metadata: {
      invoiceId: input.invoiceId,
      paidAmountCents: input.paidAmountCents ?? null,
      note: input.note,
      receipt: input.receipt,
    },
  });
  return result;
}

export const adminManualSettle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminManualSettleInput.parse(data))
  .handler(async ({ data, context }) => adminManualSettleFor(context as ServerContext, data));

export const CANCEL_INVOICE_MESSAGE =
  "Fatura cancelada. Ela será reemitida na próxima rodada com o valor atual; para não cobrar este mês, use um desconto de 100%.";

export const adminCancelInvoiceInput = z.object({
  invoiceId: dbUuid(),
  reason: reasonSchema,
});

export async function adminCancelInvoiceFor(ctx: ServerContext, data: unknown) {
  const input = adminCancelInvoiceInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const cancel = await cancelOpenPixBestEffort(input.invoiceId);

  const result = unwrap<{ tenant_id: string }>(
    await looseDb(ctx.supabase).rpc("billing_admin_cancel_invoice", {
      _invoice: input.invoiceId,
      _reason: input.reason,
    }),
  );
  await auditBillingAction({
    tenantId: result.tenant_id,
    actorUserId: ctx.userId,
    action: "billing.cancel_invoice",
    reason: input.reason,
    metadata: { invoiceId: input.invoiceId, pixCancel: cancel },
  });
  return { ...result, message: CANCEL_INVOICE_MESSAGE };
}

export const adminCancelInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminCancelInvoiceInput.parse(data))
  .handler(async ({ data, context }) => adminCancelInvoiceFor(context as ServerContext, data));

// ===========================================================================
// 8, 13, 14. Ciclo e plano
// ===========================================================================

export const adminSetCycleDayInput = z.object({
  tenantId: dbUuid(),
  nextDueDate: dateStrSchema,
  reason: reasonSchema,
});

export async function adminSetCycleDayFor(ctx: ServerContext, data: unknown) {
  const input = adminSetCycleDayInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_set_cycle_day", {
      _tenant: input.tenantId,
      _next_due: input.nextDueDate,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.set_cycle_day",
    reason: input.reason,
    metadata: { nextDueDate: input.nextDueDate },
  });
  return result;
}

export const adminSetCycleDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetCycleDayInput.parse(data))
  .handler(async ({ data, context }) => adminSetCycleDayFor(context as ServerContext, data));

export const adminSetFrozenInput = z.object({
  tenantId: dbUuid(),
  frozen: z.boolean(),
  reason: reasonSchema,
});

export async function adminSetFrozenFor(ctx: ServerContext, data: unknown) {
  const input = adminSetFrozenInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  let cancel: { attempted: boolean; ok: boolean; error?: string } = { attempted: false, ok: true };
  if (input.frozen) {
    const openInvoiceId = await findOpenInvoiceId(input.tenantId);
    cancel = await cancelOpenPixBestEffort(openInvoiceId);
  }

  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_set_frozen", {
      _tenant: input.tenantId,
      _frozen: input.frozen,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.set_frozen",
    reason: input.reason,
    metadata: { frozen: input.frozen, pixCancel: cancel },
  });
  return result;
}

export const adminSetFrozen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetFrozenInput.parse(data))
  .handler(async ({ data, context }) => adminSetFrozenFor(context as ServerContext, data));

export const adminSetCustomPriceInput = z.object({
  tenantId: dbUuid(),
  priceCents: z.number().int().nullable(),
  reason: reasonSchema,
});

export async function adminSetCustomPriceFor(ctx: ServerContext, data: unknown) {
  const input = adminSetCustomPriceInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const openInvoiceId = await findOpenInvoiceId(input.tenantId);
  const cancel = await cancelOpenPixBestEffort(openInvoiceId);

  const result = unwrap<BillingAdminResult>(
    await looseDb(ctx.supabase).rpc("billing_admin_set_custom_price", {
      _tenant: input.tenantId,
      _price_cents: input.priceCents,
    }),
  );
  await auditBillingAction({
    tenantId: input.tenantId,
    actorUserId: ctx.userId,
    action: "billing.set_custom_price",
    reason: input.reason,
    metadata: { priceCents: input.priceCents, pixCancel: cancel },
  });
  return result;
}

export const adminSetCustomPrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetCustomPriceInput.parse(data))
  .handler(async ({ data, context }) => adminSetCustomPriceFor(context as ServerContext, data));

// ===========================================================================
// 11. Reenviar e-mail
// ===========================================================================

export const adminResendBillingEmailInput = z.object({
  invoiceId: dbUuid(),
  reason: reasonSchema,
});

export async function adminResendBillingEmailFor(ctx: ServerContext, data: unknown) {
  const input = adminResendBillingEmailInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const sb = looseDb(supabaseAdmin);
  const { data: invoice, error: invoiceError } = await sb
    .from<{ id: string; tenant_id: string; status: string }>("billing_invoices")
    .select("id,tenant_id,status")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (invoiceError) throw new Error(invoiceError.message);
  if (!invoice) throw new Error(BILLING_ADMIN_ERROR_MESSAGES.invoice_not_found);
  if (invoice.status !== "open") throw new Error(BILLING_ADMIN_ERROR_MESSAGES.invoice_not_open);

  const { data: lastLog, error: logError } = await sb
    .from<{ kind: BillingEmailKind }>("billing_email_log")
    .select("kind")
    .eq("invoice_id", input.invoiceId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (logError) throw new Error(logError.message);
  const kind: BillingEmailKind = lastLog?.kind ?? "issued";

  const sendResult = await sendBillingEmail(input.invoiceId, kind, { force: true });

  await auditBillingAction({
    tenantId: invoice.tenant_id,
    actorUserId: ctx.userId,
    action: "billing.resend_email",
    reason: input.reason,
    metadata: { invoiceId: input.invoiceId, kind, ...sendResult },
  });
  return { ok: true, kind, ...sendResult };
}

export const adminResendBillingEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminResendBillingEmailInput.parse(data))
  .handler(async ({ data, context }) =>
    adminResendBillingEmailFor(context as ServerContext, data),
  );

// ===========================================================================
// Taxa do Pix
// ===========================================================================

export const adminSetPixFeeInput = z.object({
  feePercent: z.number().min(0).max(10),
  feeFixedCents: z.number().int().min(0).max(1000),
  reason: reasonSchema,
});

/**
 * No SQL RPC exists for this one (unlike the `billing_admin_*` actions):
 * `payment_fee_settings` only has a superadmin SELECT policy (Task 3/PG2),
 * writes are service_role only. So this writes through `supabaseAdmin`
 * directly, after the same TS-side `assertSuperAdmin` + reason check as
 * every other action here.
 */
export async function adminSetPixFeeFor(ctx: ServerContext, data: unknown) {
  const input = adminSetPixFeeInput.parse(data);
  await assertSuperAdmin(ctx.userId);

  const { error } = await supabaseAdmin.from("payment_fee_settings").insert({
    provider: "upper",
    fee_percent: input.feePercent,
    fee_fixed_cents: input.feeFixedCents,
    valid_from: new Date().toISOString(),
    updated_by: ctx.userId,
  });
  if (error) throw new Error(error.message);

  // payment_fee_settings is platform-wide (no tenant_id column), and
  // tenant_audit_logs.tenant_id is a NOT NULL foreign key to tenants(id): there
  // is no tenant to anchor this action to, so — like the other platform-wide
  // admin write (`setPricingFor` in admin.functions.ts, which skips it for the
  // same reason) — this one does not write a tenant_audit_logs row. The row
  // itself (`valid_from`, `updated_by`) already carries who changed it and
  // when; `reason` is still required and validated above even though it has
  // nowhere to be persisted beyond that intent (kept for API symmetry with
  // every other action here and for a future platform-wide audit table).
  return { ok: true };
}

export const adminSetPixFee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetPixFeeInput.parse(data))
  .handler(async ({ data, context }) => adminSetPixFeeFor(context as ServerContext, data));

// ===========================================================================
// Painel (adminBillingDashboard)
// ===========================================================================

export type AdminBillingDashboard = {
  mrrCents: number;
  receivedThisMonthCents: number;
  dueNext5DaysCents: number;
  overdueInvoices: number;
  lockedUnpaid: number;
  lockedManual: number;
  frozen: number;
  needsReview: number;
};

type TenantBillingRow = {
  tenant_id: string;
  plan_code: string;
  custom_price_cents: number | string | null;
  discount_kind: string | null;
  discount_value: number | string | null;
  discount_starts_on: string | null;
  discount_ends_on: string | null;
  frozen: boolean;
  access_state: string;
};

type BillingPlanRow = { code: string; price_cents: number | string; exempt_all: boolean };

function continuousDiscountCentsToday(base: number, row: TenantBillingRow, today: string): number {
  if (!row.discount_kind || row.discount_value == null) return 0;
  if (row.discount_starts_on && today < row.discount_starts_on) return 0;
  if (row.discount_ends_on && today > row.discount_ends_on) return 0;
  return discountCentsFor(base, row.discount_kind, Number(row.discount_value));
}

export async function adminBillingDashboardFor(ctx: ServerContext): Promise<AdminBillingDashboard> {
  await assertSuperAdmin(ctx.userId);
  const sb = looseDb(supabaseAdmin);

  const today = brtDayKey(new Date());
  const yyyyMm = today.slice(0, 7);
  const monthStartISO = parseBrtDayStart(`${yyyyMm}-01`).toISOString();
  const monthEndExclusiveISO = parseBrtDayStart(`${nextYyyyMm(yyyyMm)}-01`).toISOString();
  const in5Days = addDaysStr(today, 5);

  // I3: billing_invoices (open, and paid this month) and payment_charges (credit top-ups this
  // month) can each exceed PostgREST's 1000-row cap, so they page with selectAllPages instead of
  // a single `.select()` that would silently drop rows past it. `needsReview` only needs a
  // count, so it asks Postgres for one (`count: "exact", head: true`) instead of fetching rows.
  const [tenantsRes, tbRes, plansRes, openInvPaged, paidInvPaged, topupPaged, reviewRes] = await Promise.all([
    sb.from("tenants").select("id,plano"),
    sb
      .from("tenant_billing")
      .select(
        "tenant_id,plan_code,custom_price_cents,discount_kind,discount_value,discount_starts_on,discount_ends_on,frozen,access_state",
      ),
    sb.from("billing_plans").select("code,price_cents,exempt_all"),
    selectAllPages<{ id: string; amount_cents: number | string; due_date: string }>(
      "billing_invoices_open",
      () => sb.from("billing_invoices").select("id,amount_cents,due_date").eq("status", "open"),
    ),
    selectAllPages<{ id: string; paid_amount_cents: number | string | null }>(
      "billing_invoices_paid_this_month",
      () =>
        sb
          .from("billing_invoices")
          .select("id,paid_amount_cents,paid_at")
          .eq("status", "paid")
          .gte("paid_at", monthStartISO)
          .lt("paid_at", monthEndExclusiveISO),
    ),
    selectAllPages<{ id: string; paid_amount_cents: number | string | null }>(
      "payment_charges_credit_topup_this_month",
      () =>
        sb
          .from("payment_charges")
          .select("id,paid_amount_cents,credited_at")
          .eq("kind", "credit_topup")
          .not("credited_at", "is", null)
          .gte("credited_at", monthStartISO)
          .lt("credited_at", monthEndExclusiveISO),
    ),
    sb
      .from("payment_charges")
      .select("id", { count: "exact", head: true })
      .eq("needs_review", true)
      .is("credited_at", null),
  ]);

  for (const res of [tenantsRes, tbRes, plansRes, reviewRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  for (const res of [openInvPaged, paidInvPaged, topupPaged]) {
    if (res.error) throw new Error(res.error.message);
  }

  const tenants = (tenantsRes.data ?? []) as Array<{ id: string; plano: string | null }>;
  const tenantBillingRows = (tbRes.data ?? []) as TenantBillingRow[];
  const plans = (plansRes.data ?? []) as BillingPlanRow[];
  const openInvoices = openInvPaged.data;
  const paidInvoices = paidInvPaged.data;
  const topups = topupPaged.data;
  const needsReview = reviewRes.count ?? 0;

  const tenantPlanoById = new Map(tenants.map((t) => [t.id, t.plano] as const));
  const plansByCode = new Map(plans.map((p) => [p.code, p] as const));

  let mrrCents = 0;
  for (const row of tenantBillingRows) {
    if (row.frozen) continue;
    const tenantPlano = tenantPlanoById.get(row.tenant_id);
    const tenantPlan = tenantPlano ? plansByCode.get(tenantPlano) : undefined;
    if (tenantPlan?.exempt_all) continue;

    const planForPrice = plansByCode.get(row.plan_code);
    const base =
      row.custom_price_cents != null ? Number(row.custom_price_cents) : Number(planForPrice?.price_cents ?? 0);
    const discount = continuousDiscountCentsToday(base, row, today);
    mrrCents += Math.max(0, base - discount);
  }

  const receivedThisMonthCents =
    paidInvoices.reduce((sum, inv) => sum + Number(inv.paid_amount_cents ?? 0), 0) +
    topups.reduce((sum, t) => sum + Number(t.paid_amount_cents ?? 0), 0);

  const dueNext5DaysCents = openInvoices
    .filter((inv) => inv.due_date >= today && inv.due_date <= in5Days)
    .reduce((sum, inv) => sum + Number(inv.amount_cents ?? 0), 0);

  const overdueInvoices = openInvoices.filter((inv) => inv.due_date < today).length;

  const byState = (state: string) => tenantBillingRows.filter((row) => row.access_state === state).length;

  return {
    mrrCents,
    receivedThisMonthCents,
    dueNext5DaysCents,
    overdueInvoices,
    lockedUnpaid: byState("locked_unpaid"),
    lockedManual: byState("locked_manual"),
    frozen: byState("frozen"),
    needsReview,
  };
}

export const adminBillingDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminBillingDashboardFor(context as ServerContext));

// ===========================================================================
// Histórico da casa (adminTenantBillingHistory)
// ===========================================================================

export const adminTenantBillingHistoryInput = z.object({ tenantId: dbUuid() });

export type BillingHistoryItem = {
  at: string;
  kind: string;
  title: string;
  detail: string;
  actor: string | null;
};

const AUDIT_TITLES: Record<string, string> = {
  "billing.set_block": "Bloqueio manual",
  "billing.extend_due": "Prazo estendido",
  "billing.free_days": "Dias grátis concedidos",
  "billing.apply_invoice_discount": "Desconto pontual aplicado",
  "billing.set_continuous_discount": "Desconto contínuo alterado",
  "billing.manual_settle": "Baixa manual",
  "billing.cancel_invoice": "Fatura cancelada pelo superadmin",
  "billing.set_cycle_day": "Dia do ciclo alterado",
  "billing.set_frozen": "Plano congelado/descongelado",
  "billing.set_custom_price": "Preço próprio alterado",
  "billing.resend_email": "E-mail de cobrança reenviado",
};

function auditTitle(action: string): string {
  return AUDIT_TITLES[action] ?? action;
}

export async function adminTenantBillingHistoryFor(
  ctx: ServerContext,
  data: unknown,
): Promise<BillingHistoryItem[]> {
  const input = adminTenantBillingHistoryInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const sb = looseDb(supabaseAdmin);

  // m5: each source is capped at the newest 200 rows in SQL instead of paged — the merged
  // timeline only ever shows 200 items anyway, so there is no need to fetch (and page past
  // PostgREST's 1000-row cap for) rows that would be cut before display.
  const [invRes, chargesRes, auditRes] = await Promise.all([
    sb
      .from("billing_invoices")
      .select("id,amount_cents,due_date,status,paid_at,paid_via,canceled_reason,created_at,updated_at")
      .eq("tenant_id", input.tenantId)
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("payment_charges")
      .select("id,amount_cents,status,created_at,paid_at")
      .eq("tenant_id", input.tenantId)
      .eq("kind", "invoice")
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("tenant_audit_logs")
      .select("id,action,metadata,actor_user_id,created_at")
      .eq("tenant_id", input.tenantId)
      .like("action", "billing.%")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  for (const res of [invRes, chargesRes, auditRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  type InvoiceHistoryRow = {
    id: string;
    amount_cents: number | string;
    due_date: string;
    status: string;
    paid_at: string | null;
    paid_via: string | null;
    canceled_reason: string | null;
    created_at: string;
    updated_at: string;
  };
  type ChargeHistoryRow = {
    id: string;
    amount_cents: number | string;
    status: string;
    created_at: string;
    paid_at: string | null;
  };
  type AuditHistoryRow = {
    id: string;
    action: string;
    metadata: Record<string, unknown> | null;
    actor_user_id: string | null;
    created_at: string;
  };

  const invoices = (invRes.data ?? []) as InvoiceHistoryRow[];
  const charges = (chargesRes.data ?? []) as ChargeHistoryRow[];
  const auditLogs = (auditRes.data ?? []) as AuditHistoryRow[];

  const items: BillingHistoryItem[] = [];
  for (const inv of invoices) {
    items.push({
      at: inv.created_at,
      kind: "invoice_created",
      title: "Fatura criada",
      detail: `${brl(Number(inv.amount_cents))} · vencimento ${formatDateBR(inv.due_date)}`,
      actor: null,
    });
    if (inv.status === "paid" && inv.paid_at) {
      items.push({
        at: inv.paid_at,
        kind: "invoice_paid",
        title: "Fatura paga",
        detail: `${brl(Number(inv.amount_cents))} via ${viaLabel(inv.paid_via)}`,
        actor: null,
      });
    }
    if (inv.status === "canceled") {
      items.push({
        at: inv.updated_at,
        kind: "invoice_canceled",
        title: "Fatura cancelada",
        detail: inv.canceled_reason ?? "",
        actor: null,
      });
    }
  }
  for (const charge of charges) {
    items.push({
      at: charge.created_at,
      kind: "charge_created",
      title: "Pix gerado",
      detail: brl(Number(charge.amount_cents)),
      actor: null,
    });
    if (charge.status === "PAID" && charge.paid_at) {
      items.push({
        at: charge.paid_at,
        kind: "charge_paid",
        title: "Pix pago",
        detail: brl(Number(charge.amount_cents)),
        actor: null,
      });
    }
  }
  for (const log of auditLogs) {
    const reason = log.metadata && typeof log.metadata === "object" ? log.metadata.reason : undefined;
    items.push({
      at: log.created_at,
      kind: "audit",
      title: auditTitle(log.action),
      detail: typeof reason === "string" ? reason : "",
      actor: log.actor_user_id ?? null,
    });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, 200);
}

export const adminTenantBillingHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminTenantBillingHistoryInput.parse(data))
  .handler(async ({ data, context }) =>
    adminTenantBillingHistoryFor(context as ServerContext, data),
  );

// ===========================================================================
// Relatório mensal (adminBillingMonthlyCsv)
// ===========================================================================

export const adminBillingMonthlyCsvInput = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Mês inválido (use AAAA-MM)."),
});

// I4 (controller ruling, binding): there is no existing `receita` column, so `receita_bruta`
// is added right before `receita_liquida`, and the header is otherwise unchanged.
const CSV_HEADER = [
  "casa",
  "slug",
  "plano",
  "mensalidade_paga",
  "creditos_comprados",
  "consumo_sms",
  "consumo_voz",
  "consumo_email",
  "custo_fornecedor",
  "taxa_pix",
  "receita_bruta",
  "receita_liquida",
  "margem",
  "isenta",
];

function csvText(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** I2: untrusted house/plan text (from webhooks and admin input) neutralized against CSV
 * formula injection, then quoted. */
function csvTextSafe(value: string): string {
  return csvText(neutralizeCsvFormula(value));
}

export async function adminBillingMonthlyCsvFor(ctx: ServerContext, data: unknown): Promise<string> {
  const input = adminBillingMonthlyCsvInput.parse(data);
  await assertSuperAdmin(ctx.userId);
  const sb = looseDb(supabaseAdmin);

  const monthStart = `${input.month}-01`;
  const monthStartISO = parseBrtDayStart(monthStart).toISOString();
  const monthEndExclusiveISO = parseBrtDayStart(`${nextYyyyMm(input.month)}-01`).toISOString();

  type CsvTenantRow = { id: string; nome: string | null; slug: string | null; plano: string | null };
  type CsvAmountRow = { id: string; tenant_id: string; paid_amount_cents: number | string | null };
  type CsvLedgerRow = {
    id: string;
    tenant_id: string;
    item: string | null;
    units: number | string | null;
    amount: number | string;
    provider_unit_cost: number | string | null;
    entry_type: string;
  };
  type CsvFeeRow = { id: string; tenant_id: string; fee_cents: number | string | null };

  // I3: billing_invoices, payment_charges and wallet_ledger can each exceed PostgREST's
  // 1000-row cap for a busy month, so they page with selectAllPages instead of a single
  // `.select()` that would silently drop rows past it (and under-count the CSV).
  const [tenantsRes, plansRes, invPaged, topupPaged, ledgerPaged, chargesPaged, demoIds] = await Promise.all([
    sb.from("tenants").select("id,nome,slug,plano").order("nome", { ascending: true }),
    sb.from("billing_plans").select("code,price_cents,exempt_all"),
    selectAllPages<CsvAmountRow>("billing_invoices_paid_csv", () =>
      sb
        .from("billing_invoices")
        .select("id,tenant_id,paid_amount_cents")
        .eq("status", "paid")
        .gte("paid_at", monthStartISO)
        .lt("paid_at", monthEndExclusiveISO),
    ),
    selectAllPages<CsvAmountRow>("payment_charges_credit_topup_csv", () =>
      sb
        .from("payment_charges")
        .select("id,tenant_id,paid_amount_cents")
        .eq("kind", "credit_topup")
        .not("credited_at", "is", null)
        .gte("credited_at", monthStartISO)
        .lt("credited_at", monthEndExclusiveISO),
    ),
    selectAllPages<CsvLedgerRow>("wallet_ledger_csv", () =>
      sb
        .from("wallet_ledger")
        .select("id,tenant_id,item,units,amount,provider_unit_cost,entry_type")
        .eq("usage_month", monthStart)
        .in("entry_type", ["usage_reservation", "usage_refund"]),
    ),
    selectAllPages<CsvFeeRow>("payment_charges_fee_csv", () =>
      sb
        .from("payment_charges")
        .select("id,tenant_id,fee_cents")
        .eq("status", "PAID")
        .gte("paid_at", monthStartISO)
        .lt("paid_at", monthEndExclusiveISO),
    ),
    listDemoTenantIds(),
  ]);
  for (const res of [tenantsRes, plansRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  for (const res of [invPaged, topupPaged, ledgerPaged, chargesPaged]) {
    if (res.error) throw new Error(res.error.message);
  }

  const plansByCode = new Map(((plansRes.data ?? []) as BillingPlanRow[]).map((p) => [p.code, p] as const));
  const demoSet = new Set(demoIds);

  function sumBy<T>(rows: T[], tenantId: string, pick: (row: T) => number, matchKey: (row: T) => string) {
    return rows.filter((row) => matchKey(row) === tenantId).reduce((acc, row) => acc + pick(row), 0);
  }

  const tenantRows = (tenantsRes.data ?? []) as CsvTenantRow[];
  const invoiceRows = invPaged.data;
  const topupRows = topupPaged.data;
  const ledgerRows = ledgerPaged.data;
  const chargeRows = chargesPaged.data;

  type CsvRow = { cells: string[]; isenta: boolean };
  const rows: CsvRow[] = [];

  // I4 (controller ruling, binding) — formulas for the row below, all in R$ (not cents):
  //   receita          = mensalidade_paga + consumo_sms + consumo_voz + consumo_email
  //                      (creditos_comprados is an informational cash column, not revenue)
  //   receita_liquida  = receita − custo_fornecedor − taxa_pix
  //   margem           = receita_liquida / receita × 100, a plain number (comma decimals, no
  //                      "%"); left empty when receita is 0 to avoid a division by zero.
  for (const tenant of tenantRows) {
    if (demoSet.has(tenant.id)) continue;
    const plan = tenant.plano ? plansByCode.get(tenant.plano) : undefined;
    const isenta = plan?.exempt_all === true;

    const mensalidadeCents = sumBy(
      invoiceRows,
      tenant.id,
      (r) => Number(r.paid_amount_cents ?? 0),
      (r) => r.tenant_id,
    );
    const creditosCents = sumBy(
      topupRows,
      tenant.id,
      (r) => Number(r.paid_amount_cents ?? 0),
      (r) => r.tenant_id,
    );

    const consumoByItem = (item: string) =>
      -ledgerRows
        .filter((r) => r.tenant_id === tenant.id && r.item === item)
        .reduce((acc, r) => acc + Number(r.amount ?? 0), 0);

    const consumoSms = consumoByItem("sms");
    const consumoVoz = consumoByItem("voice_30s");
    const consumoEmail = consumoByItem("email");

    const custoFornecedor = ledgerRows
      .filter((r) => r.tenant_id === tenant.id)
      .reduce((acc, r) => {
        const sign = r.entry_type === "usage_reservation" ? 1 : -1;
        return acc + sign * Number(r.units ?? 0) * Number(r.provider_unit_cost ?? 0);
      }, 0);

    const taxaPixCents = sumBy(
      chargeRows,
      tenant.id,
      (r) => Number(r.fee_cents ?? 0),
      (r) => r.tenant_id,
    );

    const mensalidadeReais = mensalidadeCents / 100;
    const creditosReais = creditosCents / 100;
    const taxaPixReais = taxaPixCents / 100;
    const receitaBrutaReais = mensalidadeReais + consumoSms + consumoVoz + consumoEmail;
    const receitaLiquida = receitaBrutaReais - custoFornecedor - taxaPixReais;
    const margemText = receitaBrutaReais !== 0 ? brlReais((receitaLiquida / receitaBrutaReais) * 100) : "";

    rows.push({
      isenta,
      cells: [
        csvTextSafe(tenant.nome ?? ""),
        csvTextSafe(tenant.slug ?? ""),
        csvTextSafe(plan?.code ?? tenant.plano ?? ""),
        brlReais(mensalidadeReais),
        brlReais(creditosReais),
        brlReais(consumoSms),
        brlReais(consumoVoz),
        brlReais(consumoEmail),
        brlReais(custoFornecedor),
        brlReais(taxaPixReais),
        brlReais(receitaBrutaReais),
        brlReais(receitaLiquida),
        margemText,
        isenta ? "sim" : "não",
      ],
    });
  }

  const paying = rows.filter((r) => !r.isenta);
  const exempt = rows.filter((r) => r.isenta);
  const ordered = [...paying, ...exempt];

  const lines = [CSV_HEADER.join(";"), ...ordered.map((r) => r.cells.join(";"))];
  // BOM so Excel (pt-BR) opens accents correctly.
  return "﻿" + lines.join("\n");
}

export const adminBillingMonthlyCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminBillingMonthlyCsvInput.parse(data))
  .handler(async ({ data, context }) => adminBillingMonthlyCsvFor(context as ServerContext, data));
