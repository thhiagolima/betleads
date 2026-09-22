import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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
  upsert: (values: unknown, options?: unknown) => Promise<DbResult<T>>;
};
type LooseSupabase = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => LooseQuery<T>;
};

function looseDb(client: unknown) {
  return client as LooseSupabase;
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

export const getSmsCreditPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const ctx = context as ServerContext;
    const tenantId = await resolveTenantId(ctx, data.tenantId);
    const sb = looseDb(ctx.supabase);

    const [summaryRes, packagesRes, ordersRes, ledgerRes] = await Promise.all([
      sb.rpc("sms_credit_summary", { _tenant: tenantId }),
      sb
        .from("sms_credit_packages")
        .select("id,name,credits,bonus_credits,price_cents,currency,is_active,sort_order")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      sb
        .from("sms_credit_orders")
        .select(
          "id,credits,amount_cents,currency,status,checkout_provider,checkout_url,external_reference,created_at,paid_at",
        )
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(12),
      sb
        .from("sms_credit_ledger")
        .select("id,delta_credits,balance_after,entry_type,reason,reference_type,created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (summaryRes.error) throw new Error(summaryRes.error.message);
    if (packagesRes.error) throw new Error(packagesRes.error.message);
    if (ordersRes.error) throw new Error(ordersRes.error.message);
    if (ledgerRes.error) throw new Error(ledgerRes.error.message);

    return {
      tenantId,
      summary: summaryRes.data ?? {},
      packages: packagesRes.data ?? [],
      orders: ordersRes.data ?? [],
      ledger: ledgerRes.data ?? [],
    };
  });

const checkoutInput = z
  .object({
    tenantId: dbUuid().optional().nullable(),
    packageId: dbUuid().optional().nullable(),
    credits: z.number().int().positive().max(1_000_000).optional().nullable(),
  })
  .refine((v) => !!v.packageId || !!v.credits, {
    message: "Escolha um pacote ou informe a quantidade de créditos",
  });

export const createSmsCreditCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => checkoutInput.parse(data))
  .handler(async ({ data, context }) => {
    const ctx = context as ServerContext;
    const tenantId = await resolveTenantId(ctx, data.tenantId);
    const { data: result, error } = await looseDb(ctx.supabase).rpc("create_sms_credit_checkout", {
      _tenant: tenantId,
      _package_id: data.packageId ?? null,
      _credits: data.credits ?? null,
    });
    if (error) throw new Error(error.message);
    return { checkout: result };
  });

export const adminSmsCreditConsole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const sb = looseDb(context.supabase);

    const [overviewRes, settingsRes, packagesRes, ordersRes] = await Promise.all([
      sb.rpc("admin_sms_credit_overview"),
      sb.from("sms_credit_settings").select("*").eq("id", true).maybeSingle(),
      sb
        .from("sms_credit_packages")
        .select("id,name,credits,bonus_credits,price_cents,currency,is_active,sort_order")
        .order("sort_order", { ascending: true }),
      sb
        .from("sms_credit_orders")
        .select(
          "id,tenant_id,credits,amount_cents,currency,status,checkout_provider,external_reference,created_at,paid_at,tenants:tenants(nome)",
        )
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

    if (overviewRes.error) throw new Error(overviewRes.error.message);
    if (settingsRes.error) throw new Error(settingsRes.error.message);
    if (packagesRes.error) throw new Error(packagesRes.error.message);
    if (ordersRes.error) throw new Error(ordersRes.error.message);

    return {
      overview: overviewRes.data ?? [],
      settings: settingsRes.data ?? null,
      packages: packagesRes.data ?? [],
      orders: ordersRes.data ?? [],
    };
  });

const settingsInput = z.object({
  provider_cost_per_sms: z.number().min(0).max(1000),
  default_sale_price_per_sms: z.number().min(0).max(1000),
  min_checkout_credits: z.number().int().positive().max(10_000_000),
  low_balance_threshold: z.number().int().min(0).max(10_000_000),
});

export const adminSetSmsCreditSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => settingsInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await looseDb(context.supabase).rpc("admin_set_sms_credit_settings", {
      _provider_cost_per_sms: data.provider_cost_per_sms,
      _default_sale_price_per_sms: data.default_sale_price_per_sms,
      _min_checkout_credits: data.min_checkout_credits,
      _low_balance_threshold: data.low_balance_threshold,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const tenantPricingInput = z.object({
  tenantId: dbUuid(),
  sale_price_per_sms: z.number().min(0).max(1000).nullable(),
  provider_cost_per_sms: z.number().min(0).max(1000).nullable(),
});

export const adminSetTenantSmsPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantPricingInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await looseDb(context.supabase).rpc("admin_set_tenant_sms_pricing", {
      _tenant: data.tenantId,
      _sale_price_per_sms: data.sale_price_per_sms,
      _provider_cost_per_sms: data.provider_cost_per_sms,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminClearTenantSmsPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ tenantId: dbUuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await looseDb(context.supabase).rpc("admin_clear_tenant_sms_pricing", {
      _tenant: data.tenantId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const adjustInput = z.object({
  tenantId: dbUuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0),
  reason: z.string().min(3).max(240),
});

export const adminAdjustSmsCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adjustInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await looseDb(context.supabase).rpc("admin_adjust_sms_credits", {
      _tenant: data.tenantId,
      _delta: data.delta,
      _reason: data.reason,
      _idempotency_key: crypto.randomUUID(),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminMarkSmsCreditOrderPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({ orderId: dbUuid(), provider: z.string().min(2).max(40).default("manual") })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { error } = await looseDb(context.supabase).rpc("admin_mark_sms_credit_order_paid", {
      _order_id: data.orderId,
      _checkout_provider: data.provider,
      _external_reference: null,
      _metadata: {},
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const packageInput = z.object({
  id: dbUuid().optional().nullable(),
  name: z.string().min(2).max(120),
  credits: z.number().int().positive().max(10_000_000),
  bonus_credits: z.number().int().min(0).max(10_000_000),
  price_cents: z.number().int().min(0).max(100_000_000),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(100_000),
});

export const adminUpsertSmsCreditPackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => packageInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const payload = {
      name: data.name,
      credits: data.credits,
      bonus_credits: data.bonus_credits,
      price_cents: data.price_cents,
      is_active: data.is_active,
      sort_order: data.sort_order,
      ...(data.id ? { id: data.id } : {}),
    };
    const { error } = await looseDb(supabaseAdmin)
      .from("sms_credit_packages")
      .upsert(payload, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
