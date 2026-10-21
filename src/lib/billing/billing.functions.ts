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
import { resolveOperationalTenantId } from "../tenant-access.server";

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
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: (table: string) => { insert: (values: unknown) => Promise<DbResult> };
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
