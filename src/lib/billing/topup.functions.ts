// Server side of buying Pix credit top-ups (PG2, Task 4). `createCreditTopup`
// generates a fresh order + charge and asks Upper for a Pix code;
// `getTopupStatus` is a pure read of the charge's current state (through the
// caller's own client, so RLS hides other houses' charges) — it never calls
// Upper itself. Crediting the wallet happens elsewhere (the webhook/cron in
// Task 3, through `confirmChargeFromUpper`/`billing_credit_paid_charge`).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assertTenantCanOpenBilling,
  assertTenantNotDemo,
  requireTenantAdmin,
  resolveOperationalTenantForRequest,
} from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

import { recordChargeSnapshot } from "./payment-charges.server";
import { resolveTopupAmount, topupDescription } from "./topup";
import { createUpperCharge, UpperError, type UpperCharge } from "./upper-pix.server";

type ServerContext = {
  // The per-request, user-scoped Supabase client the auth middleware
  // attaches. `resolveOperationalTenantForRequest`/`requireTenantAdmin` and
  // `getTopupStatus`'s own read all run through this (never `supabaseAdmin`)
  // so RLS and `is_tenant_admin()`'s `auth.uid()` check apply normally.
  supabase: unknown;
  userId: string;
};

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  update: (value: Record<string, unknown>) => LooseQuery<T>;
  insert: (value: Record<string, unknown>) => LooseQuery<T>;
  maybeSingle: () => Promise<DbResult<T>>;
  single: () => Promise<DbResult<T>>;
};
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => LooseQuery<T>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

const GENERIC_UPPER_FAILURE_MESSAGE =
  "Não foi possível gerar o Pix agora. Tente de novo em instantes.";
const GATEWAY_UNAVAILABLE_MESSAGE = "Compra por Pix indisponível no momento.";
const NOT_ADMIN_MESSAGE = "Só o admin da casa pode comprar créditos";
const EXEMPT_MESSAGE = "Esta casa é isenta e não precisa comprar créditos";

function isGatewayEnabled(): boolean {
  return process.env.BILLING_GATEWAY_ENABLED === "true";
}

async function isTenantExempt(tenantId: string): Promise<boolean> {
  const { data, error } = await looseDb(supabaseAdmin).rpc("billing_tenant_exempt", {
    _tenant: tenantId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/** Logs the real cause server-side and throws only the fixed, user-safe copy. */
function logAndThrowGeneric(context: string, message: string): never {
  console.error(`[billing/topup] ${context} failed:`, message);
  throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
}

async function getTenantName(tenantId: string): Promise<string> {
  const { data, error } = await looseDb(supabaseAdmin)
    .from<{ nome: string | null }>("tenants")
    .select("nome")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) logAndThrowGeneric("getTenantName", error.message);
  return data?.nome ?? "";
}

/** Code+status only, never the raw response body (LGPD/secrets concern). */
function upperErrorSummary(error: UpperError): string {
  return `${error.code ?? "UNKNOWN"} (${error.status})`;
}

function isGatewayUnavailableError(error: UpperError): boolean {
  return error.code === "NOT_CONFIGURED" || error.code === "FEATURE_DISABLED";
}

const createTopupInput = z
  .object({
    tenantId: dbUuid().optional().nullable(),
    packageCode: z.string().max(32).optional().nullable(),
    amountCents: z.number().int().optional().nullable(),
  })
  .default({});

/**
 * Body of `createCreditTopup`, exported for tests. Follows the order from
 * the task brief: gateway on, resolve the house, admin-only, not demo, not
 * exempt, billing open, resolve the amount, insert order+charge PENDING,
 * ask Upper, snapshot the response, link the charge back onto the order.
 */
export async function createCreditTopupFor(
  ctx: ServerContext,
  data: z.infer<typeof createTopupInput>,
) {
  if (!isGatewayEnabled()) throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);

  const tenantId = await resolveOperationalTenantForRequest(
    looseDb(ctx.supabase) as unknown as Parameters<typeof resolveOperationalTenantForRequest>[0],
    ctx.userId,
    data.tenantId,
  );

  await requireTenantAdmin(
    looseDb(ctx.supabase) as unknown as Parameters<typeof requireTenantAdmin>[0],
    tenantId,
    NOT_ADMIN_MESSAGE,
  );

  await assertTenantNotDemo(tenantId);

  if (await isTenantExempt(tenantId)) throw new Error(EXEMPT_MESSAGE);
  // Read next to the exempt check, before any order/charge row exists, so
  // the description is ready the moment we need it and a read failure here
  // never leaves a half-created order/charge behind.
  const tenantName = await getTenantName(tenantId);

  await assertTenantCanOpenBilling(tenantId);

  const { amountCents, packageCode } = resolveTopupAmount({
    packageCode: data.packageCode,
    amountCents: data.amountCents,
  });

  const { data: orderRow, error: orderError } = await looseDb(supabaseAdmin)
    .from("credit_topup_orders")
    .insert({
      tenant_id: tenantId,
      amount_cents: amountCents,
      package_code: packageCode,
      status: "pending",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (orderError || !orderRow) throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);

  const orderId = (orderRow as { id: string }).id;
  const externalId = `bl-top-${orderId}`;

  const { data: chargeRow, error: chargeError } = await looseDb(supabaseAdmin)
    .from("payment_charges")
    .insert({
      tenant_id: tenantId,
      kind: "credit_topup",
      ref_id: orderId,
      provider: "upper",
      external_id: externalId,
      status: "PENDING",
      amount_cents: amountCents,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (chargeError || !chargeRow) throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);

  const chargeId = (chargeRow as { id: string }).id;

  let upper: UpperCharge;
  try {
    upper = await createUpperCharge({
      amountCents,
      description: topupDescription(tenantName, amountCents),
      externalId,
      expiresIn: 3600,
      metadata: { tenantId, kind: "credit_topup", refId: orderId },
    });
  } catch (error) {
    const summary =
      error instanceof UpperError ? upperErrorSummary(error) : "UNKNOWN_ERROR (0)";

    const { error: failChargeError } = await looseDb(supabaseAdmin)
      .from("payment_charges")
      .update({ status: "FAILED", last_error: summary, updated_at: new Date().toISOString() })
      .eq("id", chargeId);
    if (failChargeError) logAndThrowGeneric("mark charge FAILED", failChargeError.message);

    const { error: failOrderError } = await looseDb(supabaseAdmin)
      .from("credit_topup_orders")
      .update({ status: "failed" })
      .eq("id", orderId);
    if (failOrderError) logAndThrowGeneric("mark order failed", failOrderError.message);

    if (error instanceof UpperError && isGatewayUnavailableError(error)) {
      throw new Error(GATEWAY_UNAVAILABLE_MESSAGE);
    }
    throw new Error(GENERIC_UPPER_FAILURE_MESSAGE);
  }

  try {
    await recordChargeSnapshot(chargeId, upper);
  } catch (error) {
    logAndThrowGeneric(
      "recordChargeSnapshot",
      error instanceof Error ? error.message : String(error),
    );
  }

  const { error: linkError } = await looseDb(supabaseAdmin)
    .from("credit_topup_orders")
    .update({ charge_id: chargeId })
    .eq("id", orderId);
  if (linkError) logAndThrowGeneric("link charge_id onto order", linkError.message);

  return {
    orderId,
    chargeId,
    status: upper.status,
    amountCents,
    emv: upper.emv,
    qrCodeImage: upper.qrCodeImage,
    paymentUrl: upper.paymentUrl,
    expiresAt: upper.expiresAt,
  };
}

export const createCreditTopup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createTopupInput.parse(data ?? {}))
  .handler(async ({ data, context }) => createCreditTopupFor(context as ServerContext, data));

const getTopupStatusInput = z.object({
  chargeId: dbUuid(),
});

/**
 * Body of `getTopupStatus`, exported for tests. Reads `payment_charges`
 * through the caller's own client (`ctx.supabase`), never `supabaseAdmin`,
 * so RLS hides charges belonging to other houses; it never calls Upper.
 */
export async function getTopupStatusFor(
  ctx: ServerContext,
  data: z.infer<typeof getTopupStatusInput>,
) {
  const { data: row, error } = await looseDb(ctx.supabase)
    .from<{ status: string; paid_at: string | null; credited_at: string | null }>(
      "payment_charges",
    )
    .select("status,paid_at,credited_at")
    .eq("id", data.chargeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Cobrança não encontrada");

  return {
    status: row.status,
    paidAt: row.paid_at,
    credited: row.credited_at !== null,
  };
}

export const getTopupStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => getTopupStatusInput.parse(data))
  .handler(async ({ data, context }) => getTopupStatusFor(context as ServerContext, data));
