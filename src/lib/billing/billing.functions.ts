// PG1 Task 7/8 — billing server functions for the price book (billing_price_book
// / Task 2): `getBillingPrices` is the house-facing read (the SMS composer and
// anything else that needs to show "this costs R$ X"); `adminSetTenantPrice`/
// `adminClearTenantPrice` are the superadmin-only per-tenant override, by item
// (sms, voice_30s, email), replacing the old SMS-only
// adminSetTenantSmsPricing/adminClearTenantSmsPricing. The global default
// prices (getPricing/setPricing) stay in admin.functions.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { dbUuid } from "@/lib/zod-helpers";
import { getEffectivePrices } from "./pricing.server";
import { resolveOperationalTenantId, resolveTenantForBilling } from "../tenant-access.server";
import { isBillingEnforcementEnabled, isTenantPayer, requireTenantPayer } from "./billing-state.server";
import { billingView, type BillingRole } from "./billing-view";
import { createInvoicePayment } from "./invoices.server";
import { getEndToEndOrExternalId } from "./payment-reference.server";
import { brtDayKey } from "../tz";

type ServerContext = {
  userId: string;
  // Loose on purpose: the real runtime value is the per-request, user-scoped
  // Supabase client the auth middleware attaches (never `supabaseAdmin`).
  // RPCs that check `is_super_admin()` with no service_role bypass
  // (admin_set_tenant_price, admin_clear_tenant_price, admin_set_price,
  // admin_adjust_wallet) MUST run through this client — `auth.uid()` is null
  // on `supabaseAdmin`, so `is_super_admin()` is false there and the call
  // fails with `forbidden` even for a real super admin.
  supabase: unknown;
};

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
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

export const getBillingPrices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return getEffectivePrices(tenantId);
  });

export const billingItem = z.enum(["sms", "voice_30s", "email"]);

async function assertSuperAdmin(userId: string) {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas o super admin pode realizar esta ação");
}

/**
 * Best-effort snapshot of the tenant's effective price for an item, used as
 * before/after in the audit log. Never blocks the mutation if it fails to
 * read (mirrors `getSmsPricing`'s warn-and-null pattern in
 * sms-credits.functions.ts).
 */
async function getTenantPriceSnapshot(tenantId: string, item: string) {
  const { data, error } = await looseDb(supabaseAdmin).rpc("billing_effective_price", {
    _tenant: tenantId,
    _item: item,
  });
  if (error) {
    console.warn("[billing] failed loading price snapshot for audit", error.message);
    return null;
  }
  return data;
}

async function auditTenantPriceChange(args: {
  tenantId: string;
  actorUserId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await looseDb(supabaseAdmin).from("tenant_audit_logs").insert({
    tenant_id: args.tenantId,
    actor_user_id: args.actorUserId,
    action: args.action,
    entity_type: "tenant_price_override",
    entity_id: args.tenantId,
    before_data: (args.before ?? null) as Json,
    after_data: (args.after ?? null) as Json,
    metadata: (args.metadata ?? {}) as Json,
  });
  if (error) {
    console.warn("[billing] failed writing tenant audit log", error.message);
  }
}

const tenantEffectivePriceInput = z.object({
  tenantId: dbUuid(),
  item: billingItem,
});

/**
 * One tenant's current effective price for one item (`billing_effective_price`,
 * which has a service_role bypass, so this is safe to read via
 * `supabaseAdmin`). Used by the per-tenant price dialog (admin.tsx) to
 * prefill `unitPrice` with the actually-current value instead of a literal,
 * and to know whether "Voltar ao padrão" applies to the selected item.
 */
export async function getTenantEffectivePriceFor(
  ctx: ServerContext,
  data: z.infer<typeof tenantEffectivePriceInput>,
) {
  await assertSuperAdmin(ctx.userId);
  const { data: row, error } = await looseDb(supabaseAdmin).rpc("billing_effective_price", {
    _tenant: data.tenantId,
    _item: data.item,
  });
  if (error) throw new Error(error.message);
  const price = (row ?? {}) as { unit_price?: number | string | null; source?: string | null };
  return {
    unitPrice: price.unit_price == null ? null : Number(price.unit_price),
    hasOverride: price.source === "override",
  };
}

export const getTenantEffectivePrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantEffectivePriceInput.parse(data))
  .handler(async ({ data, context }) =>
    getTenantEffectivePriceFor(context as ServerContext, data),
  );

const setTenantPriceInput = z.object({
  tenantId: dbUuid(),
  item: billingItem,
  unitPrice: z.number().min(0).max(1000),
});

export async function adminSetTenantPriceFor(
  ctx: ServerContext,
  data: z.infer<typeof setTenantPriceInput>,
) {
  await assertSuperAdmin(ctx.userId);
  const before = await getTenantPriceSnapshot(data.tenantId, data.item);
  // See the `supabase` field comment on `ServerContext`: must run as the
  // caller, not through `supabaseAdmin`.
  const { error } = await looseDb(ctx.supabase).rpc("admin_set_tenant_price", {
    _tenant: data.tenantId,
    _item: data.item,
    _unit_price: data.unitPrice,
  });
  if (error) throw new Error(error.message);
  const after = await getTenantPriceSnapshot(data.tenantId, data.item);
  await auditTenantPriceChange({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_price.set",
    before,
    after,
    metadata: { item: data.item, unit_price: data.unitPrice },
  });
  return { ok: true };
}

export const adminSetTenantPrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setTenantPriceInput.parse(data))
  .handler(async ({ data, context }) => adminSetTenantPriceFor(context as ServerContext, data));

const clearTenantPriceInput = z.object({
  tenantId: dbUuid(),
  item: billingItem,
});

export async function adminClearTenantPriceFor(
  ctx: ServerContext,
  data: z.infer<typeof clearTenantPriceInput>,
) {
  await assertSuperAdmin(ctx.userId);
  const before = await getTenantPriceSnapshot(data.tenantId, data.item);
  // See the `supabase` field comment on `ServerContext`: must run as the
  // caller, not through `supabaseAdmin`.
  const { error } = await looseDb(ctx.supabase).rpc("admin_clear_tenant_price", {
    _tenant: data.tenantId,
    _item: data.item,
  });
  if (error) throw new Error(error.message);
  const after = await getTenantPriceSnapshot(data.tenantId, data.item);
  await auditTenantPriceChange({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_price.cleared",
    before,
    after,
    metadata: { item: data.item },
  });
  return { ok: true };
}

export const adminClearTenantPrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => clearTenantPriceInput.parse(data))
  .handler(async ({ data, context }) => adminClearTenantPriceFor(context as ServerContext, data));

// ---------------------------------------------------------------------------
// Task 7 — "Plano e créditos" page: getPlanOverview, payInvoice,
// getInvoiceReceipt. All three resolve the house through
// `resolveTenantForBilling` (works even for a locked house) and read with
// `supabaseAdmin`, scoped to that resolved tenantId — never `manual_note`,
// `manual_receipt` or `manual_block_reason` reach the client.
// ---------------------------------------------------------------------------

const NOT_PAYER_MESSAGE = "Peça ao administrador da casa para pagar a mensalidade.";
const INVOICE_NOT_FOUND_MESSAGE = "Fatura não encontrada.";
const INVOICE_NOT_PAID_MESSAGE = "Esta fatura ainda não foi paga.";

async function isSuperAdminLoose(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return data === true;
}

type TenantBillingRow = {
  tenant_id: string;
  plan_code: string;
  custom_price_cents: number | string | null;
  discount_kind: "percent" | "fixed" | null;
  discount_value: number | string | null;
  discount_starts_on: string | null;
  discount_ends_on: string | null;
  next_due_date: string | null;
  manual_block: boolean;
  frozen: boolean;
  access_state: string;
};

type BillingPlanRow = { code: string; name: string; price_cents: number | string; exempt_all: boolean };

type InvoiceRow = {
  id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  cycle_due_date: string;
  due_date: string;
  amount_cents: number | string;
  discount_cents: number | string;
  one_off_discount_cents: number | string;
  status: "open" | "paid" | "canceled";
  paid_at: string | null;
  paid_via: "pix" | "manual" | "full_discount" | null;
  payment_charge_id: string | null;
};

type InvoiceDTO = {
  id: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountCents: number;
  discountCents: number;
  status: "open" | "paid" | "canceled";
  paidAt: string | null;
  paidVia: "pix" | "manual" | "full_discount" | null;
};

function toInvoiceDTO(row: InvoiceRow): InvoiceDTO {
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    amountCents: Number(row.amount_cents),
    discountCents: Number(row.discount_cents) + Number(row.one_off_discount_cents),
    status: row.status,
    paidAt: row.paid_at,
    paidVia: row.paid_via,
  };
}

// `toLocaleString("pt-BR", {style: "currency"})` inserts a U+00A0 (NBSP)
// between "R$" and the number; built via `String.fromCharCode` -- never as
// a literal NBSP character in source -- so this file has no irregular
// whitespace for eslint(no-irregular-whitespace) to flag.
const NBSP_PATTERN = new RegExp(String.fromCharCode(160), "g");

/** "20% de desconto" or "R$ 100,00 de desconto"; null when there is no active discount. */
function planDiscountLabel(kind: "percent" | "fixed" | null, value: number | string | null): string | null {
  if (!kind || value == null) return null;
  if (kind === "percent") return `${Number(value)}% de desconto`;
  const brlValue = (Number(value) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  return `${brlValue.replace(NBSP_PATTERN, " ")} de desconto`;
}

const planOverviewInput = z
  .object({ tenantId: dbUuid().optional().nullable() })
  .default({});

/**
 * Body of `getPlanOverview`, exported for tests. Resolves the house through
 * `resolveTenantForBilling` (a locked house still reaches this page), then
 * reads `tenant_billing`/`billing_plans`/`billing_invoices` with
 * `supabaseAdmin` scoped to that tenantId. A house with `access_state =
 * 'exempt'` never has invoices (ruling 4/6): `plan`, `currentPeriod` and
 * `openInvoice` are null and `invoices` is always `[]` for it.
 */
export async function getPlanOverviewFor(
  ctx: ServerContext,
  data: z.infer<typeof planOverviewInput>,
) {
  const tenantId = await resolveTenantForBilling(
    ctx.supabase as unknown as Parameters<typeof resolveTenantForBilling>[0],
    ctx.userId,
    data.tenantId,
  );

  const [superAdmin, payer, billingRes, invoicesRes] = await Promise.all([
    isSuperAdminLoose(ctx.userId),
    isTenantPayer(ctx.supabase, tenantId, ctx.userId),
    looseDb(supabaseAdmin)
      .from<TenantBillingRow>("tenant_billing")
      .select(
        "tenant_id,plan_code,custom_price_cents,discount_kind,discount_value,discount_starts_on,discount_ends_on,next_due_date,manual_block,frozen,access_state",
      )
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    looseDb(supabaseAdmin)
      .from<InvoiceRow[]>("billing_invoices")
      .select(
        "id,tenant_id,period_start,period_end,cycle_due_date,due_date,amount_cents,discount_cents,one_off_discount_cents,status,paid_at,paid_via,payment_charge_id",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(60),
  ]);
  if (billingRes.error) throw new Error(billingRes.error.message);
  if (invoicesRes.error) throw new Error(invoicesRes.error.message);

  const tb = billingRes.data as TenantBillingRow | null;
  const role: BillingRole = superAdmin ? "super_admin" : payer ? "payer" : "member";
  const exempt = tb?.access_state === "exempt";
  const allInvoices = invoicesRes.data ?? [];
  const today = brtDayKey(new Date());
  const enforcement = isBillingEnforcementEnabled();

  if (exempt || !tb) {
    return {
      state: tb?.access_state ?? "exempt",
      plan: null,
      exempt: true,
      currentPeriod: null,
      nextDueDate: null,
      openInvoice: null,
      invoices: [] as InvoiceDTO[],
      canPay: role !== "member",
      // Exempt houses never block credit purchases (`billingView`'s own
      // "exempt" case: `canBuyCredits: true`) — the fix-round-1 bug had this
      // reading `role !== "member"`, which showed the "Disponível depois de
      // pagar a mensalidade" lock copy to an exempt member for no reason.
      canBuyCredits: true,
      today,
      enforcement,
    };
  }

  const invoices = allInvoices.map(toInvoiceDTO);
  const openInvoiceRow = allInvoices.find((row) => row.status === "open") ?? null;
  const openInvoice = openInvoiceRow ? toInvoiceDTO(openInvoiceRow) : null;

  const cycleDueForAmount = openInvoiceRow?.cycle_due_date ?? tb.next_due_date ?? today;
  const { data: amountRow, error: amountError } = await looseDb(supabaseAdmin).rpc(
    "billing_monthly_amount",
    { _tenant: tenantId, _cycle_due: cycleDueForAmount },
  );
  if (amountError) throw new Error(amountError.message);
  const amount = (amountRow ?? {}) as {
    base_cents?: number;
    discount_cents?: number;
    amount_cents?: number;
  };

  const { data: planRow, error: planError } = await looseDb(supabaseAdmin)
    .from<BillingPlanRow>("billing_plans")
    .select("code,name,price_cents,exempt_all")
    .eq("code", tb.plan_code)
    .maybeSingle();
  if (planError) throw new Error(planError.message);

  const view = billingView({
    state: tb.access_state as Parameters<typeof billingView>[0]["state"],
    role,
    enforcement,
    invoice: openInvoice ? { amountCents: openInvoice.amountCents, dueDate: openInvoice.dueDate } : null,
    today,
  });

  return {
    state: tb.access_state,
    plan: {
      name: (planRow as BillingPlanRow | null)?.name ?? "Plano CRM",
      priceCents: Number(amount.base_cents ?? 0),
      discountedCents: Number(amount.amount_cents ?? amount.base_cents ?? 0),
      discountLabel:
        Number(amount.discount_cents ?? 0) > 0
          ? planDiscountLabel(tb.discount_kind, tb.discount_value)
          : null,
    },
    exempt: false,
    currentPeriod: openInvoice ? { start: openInvoice.periodStart, end: openInvoice.periodEnd } : null,
    nextDueDate: tb.next_due_date,
    openInvoice,
    invoices,
    canPay: role !== "member",
    canBuyCredits: view.canBuyCredits,
    today,
    enforcement,
  };
}

export const getPlanOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => planOverviewInput.parse(data ?? {}))
  .handler(async ({ data, context }) => getPlanOverviewFor(context as ServerContext, data));

const payInvoiceInput = z.object({
  tenantId: dbUuid().optional().nullable(),
  invoiceId: dbUuid(),
});

/**
 * Body of `payInvoice`, exported for tests. Requires `requireTenantPayer`
 * (admin/owner/gestor/superadmin) and that the invoice belongs to the
 * resolved house — an invoice id of another tenant (or one that doesn't
 * exist) is refused with the same `"Fatura não encontrada."` either way, so
 * this never confirms/denies another house's invoice ids. The open/paid
 * checks and the Pix creation itself are `createInvoicePayment`'s job
 * (invoices.server.ts).
 */
export async function payInvoiceFor(ctx: ServerContext, data: z.infer<typeof payInvoiceInput>) {
  const tenantId = await resolveTenantForBilling(
    ctx.supabase as unknown as Parameters<typeof resolveTenantForBilling>[0],
    ctx.userId,
    data.tenantId,
  );
  await requireTenantPayer(ctx.supabase, tenantId, NOT_PAYER_MESSAGE, ctx.userId);

  const { data: invoiceRow, error } = await looseDb(supabaseAdmin)
    .from<{ id: string; tenant_id: string }>("billing_invoices")
    .select("id,tenant_id")
    .eq("id", data.invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoiceRow || invoiceRow.tenant_id !== tenantId) {
    throw new Error(INVOICE_NOT_FOUND_MESSAGE);
  }

  return createInvoicePayment(data.invoiceId, ctx.userId);
}

export const payInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => payInvoiceInput.parse(data))
  .handler(async ({ data, context }) => payInvoiceFor(context as ServerContext, data));

const NOT_THRESHOLD_EDITOR_MESSAGE =
  "Só o administrador ou gestor da casa pode alterar o limite de saldo baixo.";
const INVALID_THRESHOLD_MESSAGE = "Informe um valor entre R$ 0 e R$ 100.000.";
const THRESHOLD_SAVE_FAILED_MESSAGE = "Não foi possível salvar o limite agora. Tente de novo.";

export const lowBalanceThresholdInput = z.object({
  tenantId: dbUuid().optional().nullable(),
  value: z
    .number()
    .finite()
    .min(0)
    .max(100000)
    .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6, {
      message: "No máximo 2 casas decimais.",
    }),
});

/**
 * Body of `setLowBalanceThreshold` (PG3 Task 8), exported for tests. The
 * house's payers (admin, owner, gestor) and the superadmin may change it.
 * `billing_set_low_balance_threshold` re-checks the role, enforces 0-100000
 * and writes the audit row; it runs on the caller's own client because it
 * reads `auth.uid()`.
 */
export async function setLowBalanceThresholdFor(
  ctx: ServerContext,
  data: z.infer<typeof lowBalanceThresholdInput>,
) {
  const tenantId = await resolveTenantForBilling(
    ctx.supabase as unknown as Parameters<typeof resolveTenantForBilling>[0],
    ctx.userId,
    data.tenantId,
  );
  await requireTenantPayer(ctx.supabase, tenantId, NOT_THRESHOLD_EDITOR_MESSAGE, ctx.userId);

  const { data: row, error } = await looseDb(ctx.supabase).rpc<{
    low_balance_threshold?: number | string;
  }>("billing_set_low_balance_threshold", { _tenant: tenantId, _value: data.value });
  if (error) {
    if (error.message.includes("invalid_threshold")) throw new Error(INVALID_THRESHOLD_MESSAGE);
    if (error.message.includes("forbidden")) throw new Error(NOT_THRESHOLD_EDITOR_MESSAGE);
    console.error("[billing] billing_set_low_balance_threshold failed", error.message);
    throw new Error(THRESHOLD_SAVE_FAILED_MESSAGE);
  }
  return { ok: true as const, lowBalanceThreshold: Number(row?.low_balance_threshold ?? data.value) };
}

export const setLowBalanceThreshold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => lowBalanceThresholdInput.parse(data))
  .handler(async ({ data, context }) => setLowBalanceThresholdFor(context as ServerContext, data));

const invoiceReceiptInput = z.object({
  tenantId: dbUuid().optional().nullable(),
  invoiceId: dbUuid(),
});

type ReceiptInvoiceRow = {
  id: string;
  tenant_id: string;
  status: "open" | "paid" | "canceled";
  period_start: string;
  period_end: string;
  cycle_due_date: string;
  paid_at: string | null;
  paid_amount_cents: number | string | null;
  amount_cents: number | string;
  paid_via: "pix" | "manual" | "full_discount" | null;
  payment_charge_id: string | null;
};

/**
 * Body of `getInvoiceReceipt`, exported for tests. Any member of the house
 * may read a receipt (it's not a money action); only a PAID invoice of the
 * resolved house qualifies — an open/canceled invoice, or one belonging to
 * another tenant, is refused. Reads `payment_charges.last_provider_payload`
 * only to pull `endToEndId`, and never returns the payload itself.
 */
export async function getInvoiceReceiptFor(
  ctx: ServerContext,
  data: z.infer<typeof invoiceReceiptInput>,
) {
  const tenantId = await resolveTenantForBilling(
    ctx.supabase as unknown as Parameters<typeof resolveTenantForBilling>[0],
    ctx.userId,
    data.tenantId,
  );

  const { data: invoiceRow, error } = await looseDb(supabaseAdmin)
    .from<ReceiptInvoiceRow>("billing_invoices")
    .select(
      "id,tenant_id,status,period_start,period_end,cycle_due_date,paid_at,paid_amount_cents,amount_cents,paid_via,payment_charge_id",
    )
    .eq("id", data.invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const invoice = invoiceRow as ReceiptInvoiceRow | null;
  if (!invoice || invoice.tenant_id !== tenantId) throw new Error(INVOICE_NOT_FOUND_MESSAGE);
  if (invoice.status !== "paid") throw new Error(INVOICE_NOT_PAID_MESSAGE);

  const endToEndOrExternalId = await getEndToEndOrExternalId(
    supabaseAdmin,
    invoice.payment_charge_id,
  );

  const [year, month] = invoice.cycle_due_date.split("-");
  return {
    paidAt: invoice.paid_at,
    amountCents: Number(invoice.paid_amount_cents ?? invoice.amount_cents),
    description: `Mensalidade BetLeads ${month}/${year}`,
    endToEndOrExternalId,
    paidVia: invoice.paid_via,
  };
}

export const getInvoiceReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => invoiceReceiptInput.parse(data))
  .handler(async ({ data, context }) => getInvoiceReceiptFor(context as ServerContext, data));
