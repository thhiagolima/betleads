// PG1 Task 8 — per-tenant price overrides (billing_price_book / Task 2) used
// by the "preço por casa" dialog in admin.tsx and tenants.tsx. Superadmin
// only. The global default prices (getPricing/setPricing) stay in
// admin.functions.ts; this file is only the per-tenant override, by item
// (sms, voice_30s, email), replacing the old SMS-only
// adminSetTenantSmsPricing/adminClearTenantSmsPricing.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = { userId: string };

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: (table: string) => { insert: (values: unknown) => Promise<DbResult> };
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

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
  const { error } = await looseDb(supabaseAdmin).rpc("admin_set_tenant_price", {
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
  const { error } = await looseDb(supabaseAdmin).rpc("admin_clear_tenant_price", {
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
