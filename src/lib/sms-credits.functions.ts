import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { listDemoTenantIds } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = {
  supabase: typeof supabaseAdmin;
  userId: string;
};

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseQuery<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string, options?: unknown) => LooseQuery<T>;
  eq: (column: string, value: unknown) => LooseQuery<T>;
  not: (column: string, operator: string, value: unknown) => LooseQuery<T>;
  order: (column: string, options?: unknown) => LooseQuery<T>;
  limit: (count: number) => LooseQuery<T>;
  maybeSingle: () => Promise<DbResult<T>>;
};
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => LooseQuery<T>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
}

/**
 * The house-facing wallet summary (`wallet_summary`, Task 3) already strips
 * `provider_unit_cost` from `prices.<item>` for anyone who is not the super
 * admin (the same rule `billing_effective_price` applies). This is a
 * belt-and-suspenders second layer at the application boundary, the same
 * pattern this file already used for the old `sms_credit_summary.pricing`.
 */
export function withoutProviderCost(summary: unknown): { [key: string]: Json } {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  const { prices, ...rest } = summary as { [key: string]: Json };
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) return rest;
  const strippedPrices: Record<string, Json> = {};
  for (const [item, price] of Object.entries(prices as Record<string, Json>)) {
    if (price && typeof price === "object" && !Array.isArray(price)) {
      const { provider_unit_cost: _hidden, ...publicPrice } = price as { [key: string]: Json };
      strippedPrices[item] = publicPrice;
    } else {
      strippedPrices[item] = price;
    }
  }
  return { ...rest, prices: strippedPrices };
}

async function getWalletSummarySnapshot(tenantId: string) {
  const { data, error } = await looseDb(supabaseAdmin).rpc("wallet_summary", {
    _tenant: tenantId,
  });
  if (error) {
    console.warn("[sms-credits] failed loading wallet summary for audit", error.message);
    return null;
  }
  return data;
}

async function auditTenantChange(args: {
  tenantId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin.from("tenant_audit_logs").insert({
    tenant_id: args.tenantId,
    actor_user_id: args.actorUserId,
    action: args.action,
    entity_type: args.entityType,
    entity_id: args.entityId ?? null,
    before_data: (args.before ?? null) as Json,
    after_data: (args.after ?? null) as Json,
    metadata: (args.metadata ?? {}) as Json,
  });
  if (error) {
    console.warn("[sms-credits] failed writing tenant audit log", error.message);
  }
}

async function assertSuperAdmin(userId: string) {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas o super admin pode realizar esta ação");
}

async function isSuperAdmin(userId: string) {
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (error) throw new Error(error.message);
  return !!data;
}

async function resolveTenantId(context: ServerContext, requestedTenantId?: string | null) {
  if (requestedTenantId) {
    const superAdmin = await isSuperAdmin(context.userId);
    if (superAdmin) return requestedTenantId;

    const { data, error } = await context.supabase
      .from("user_roles")
      .select("tenant_id")
      .eq("user_id", context.userId)
      .eq("tenant_id", requestedTenantId)
      .limit(1);
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("Tenant sem acesso");
    return requestedTenantId;
  }

  const { data, error } = await context.supabase
    .from("user_roles")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .not("tenant_id", "is", null)
    .order("tenant_id")
    .limit(1);
  if (error) throw new Error(error.message);
  const tenantId = data?.[0]?.tenant_id;
  if (!tenantId) throw new Error("Usuário sem tenant");
  return tenantId;
}

const tenantInput = z
  .object({
    tenantId: dbUuid().optional().nullable(),
  })
  .default({});

/**
 * Body of `getSmsCreditPortal`, exported for tests. Reads the wallet through
 * the caller's own client (`ctx.supabase`), never `supabaseAdmin`, so RLS
 * and the `wallet_ledger` column grant (no `provider_unit_cost` for
 * `authenticated`) apply exactly as they do for any other house query.
 */
export async function getSmsCreditPortalFor(
  ctx: ServerContext,
  data: { tenantId?: string | null },
) {
  const tenantId = await resolveTenantId(ctx, data.tenantId);
  const sb = looseDb(ctx.supabase);

  const [summaryRes, ledgerRes] = await Promise.all([
    sb.rpc("wallet_summary", { _tenant: tenantId }),
    sb
      .from("wallet_ledger")
      .select(
        "id,entry_type,item,units,free_units,unit_price,amount,balance_after,reference_type,reference_id,reason,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (summaryRes.error) throw new Error(summaryRes.error.message);
  if (ledgerRes.error) throw new Error(ledgerRes.error.message);

  return {
    tenantId,
    summary: withoutProviderCost(summaryRes.data),
    ledger: ledgerRes.data ?? [],
  };
}

export const getSmsCreditPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantInput.parse(data ?? {}))
  .handler(async ({ data, context }) => getSmsCreditPortalFor(context as ServerContext, data));

const checkoutInput = z
  .object({
    tenantId: dbUuid().optional().nullable(),
  })
  .default({});

const PURCHASE_UNAVAILABLE_MESSAGE =
  "Compra por Pix disponível em breve. Fale com o suporte para adicionar saldo.";

/**
 * Real Pix checkout arrives in PG2. Until then this (and
 * `adminMarkSmsCreditOrderPaid`) always refuses with the same message; the
 * old package/credits checkout RPC is no longer called.
 */
export async function createSmsCreditCheckoutFor(
  _ctx: ServerContext,
  _data: { tenantId?: string | null },
) {
  throw new Error(PURCHASE_UNAVAILABLE_MESSAGE);
}

export const createSmsCreditCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => checkoutInput.parse(data))
  .handler(async ({ data, context }) =>
    createSmsCreditCheckoutFor(context as ServerContext, data),
  );

export const adminMarkSmsCreditOrderPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ orderId: dbUuid() }).parse(data),
  )
  .handler(async ({ context }) => {
    await assertSuperAdmin((context as ServerContext).userId);
    throw new Error(PURCHASE_UNAVAILABLE_MESSAGE);
  });

type WalletTenantRow = {
  tenant_id: string;
  tenant_name: string | null;
  balance: number;
  lifetime_purchased: number;
  lifetime_used: number;
  exempt: boolean;
  has_custom_pricing: boolean;
};

/**
 * Body of `adminSmsCreditConsole`, exported so the demo-tenant filtering is
 * directly unit-testable (mirrors the existing `*For` convention used for
 * other demo-sensitive handlers in this codebase).
 *
 * This screen lists every tenant's wallet (unlike the per-tenant drill-down
 * in tenants.tsx, where the demo tenant's own balance IS shown). The demo
 * tenant is a clone of a real client (Task 12), so without this filter it
 * would duplicate that client's balance here. There is no admin-wide wallet
 * RPC (unlike the old `admin_sms_credit_overview`), so this reads
 * `tenant_wallets`/`tenant_price_overrides` directly with `supabaseAdmin`
 * (service_role bypasses RLS; the superadmin check already ran above).
 */
export async function adminSmsCreditConsoleFor(ctx: ServerContext) {
  await assertSuperAdmin(ctx.userId);
  const sb = looseDb(supabaseAdmin);

  const [tenantsRes, walletsRes, overridesRes, ordersRes, demoTenantIds] = await Promise.all([
    sb.from("tenants").select("id,nome,slug,plano").order("nome", { ascending: true }),
    sb.from("tenant_wallets").select("tenant_id,balance,lifetime_purchased,lifetime_used"),
    sb.from("tenant_price_overrides").select("tenant_id,unit_price").not("unit_price", "is", null),
    sb
      .from("sms_credit_orders")
      .select(
        "id,tenant_id,credits,amount_cents,currency,status,checkout_provider,external_reference,created_at,paid_at,tenants:tenants(nome)",
      )
      .order("created_at", { ascending: false })
      .limit(30),
    listDemoTenantIds(),
  ]);

  if (tenantsRes.error) throw new Error(tenantsRes.error.message);
  if (walletsRes.error) throw new Error(walletsRes.error.message);
  if (overridesRes.error) throw new Error(overridesRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);

  const demoIds = new Set(demoTenantIds);
  const walletByTenant = new Map(
    ((walletsRes.data ?? []) as Array<{
      tenant_id: string;
      balance: number;
      lifetime_purchased: number;
      lifetime_used: number;
    }>).map((row) => [row.tenant_id, row]),
  );
  const overrideTenantIds = new Set(
    ((overridesRes.data ?? []) as Array<{ tenant_id: string }>).map((row) => row.tenant_id),
  );

  const wallets: WalletTenantRow[] = ((tenantsRes.data ?? []) as Array<{
    id: string;
    nome: string | null;
    plano: string | null;
  }>)
    .filter((tenant) => !demoIds.has(tenant.id))
    .map((tenant) => {
      const wallet = walletByTenant.get(tenant.id);
      return {
        tenant_id: tenant.id,
        tenant_name: tenant.nome,
        balance: Number(wallet?.balance ?? 0),
        lifetime_purchased: Number(wallet?.lifetime_purchased ?? 0),
        lifetime_used: Number(wallet?.lifetime_used ?? 0),
        exempt: tenant.plano === "interno",
        has_custom_pricing: overrideTenantIds.has(tenant.id),
      };
    });

  const orders = ((ordersRes.data ?? []) as Array<{ tenant_id: string }>).filter(
    (row) => !demoIds.has(row.tenant_id),
  );

  return { wallets, orders };
}

export const adminSmsCreditConsole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminSmsCreditConsoleFor(context as ServerContext));

/** Exported so the zod rule ("amount !== 0") can be exercised directly in tests. */
export function adjustWalletInputFor() {
  return adjustInput;
}

const adjustInput = z.object({
  tenantId: dbUuid(),
  amount: z
    .number()
    .min(-100_000)
    .max(100_000)
    .refine((v) => v !== 0, "O valor não pode ser zero"),
  reason: z.string().min(3).max(240),
});

export async function adminAdjustSmsCreditsFor(
  ctx: ServerContext,
  data: z.infer<typeof adjustInput>,
) {
  await assertSuperAdmin(ctx.userId);
  const before = await getWalletSummarySnapshot(data.tenantId);
  const { error } = await looseDb(supabaseAdmin).rpc("admin_adjust_wallet", {
    _tenant: data.tenantId,
    _amount: data.amount,
    _reason: data.reason,
  });
  if (error) throw new Error(error.message);
  const after = await getWalletSummarySnapshot(data.tenantId);
  await auditTenantChange({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_wallet.adjusted",
    entityType: "tenant_wallet",
    entityId: data.tenantId,
    before,
    after,
    metadata: {
      amount: data.amount,
      reason: data.reason,
    },
  });
  return { ok: true };
}

export const adminAdjustSmsCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adjustInput.parse(data))
  .handler(async ({ data, context }) => adminAdjustSmsCreditsFor(context as ServerContext, data));
