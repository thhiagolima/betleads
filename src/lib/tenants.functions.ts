import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { assertTenantNotDemo } from "@/lib/tenant-access.server";
import { auditTenant } from "@/lib/tenant-audit.server";
import { dbUuid } from "@/lib/zod-helpers";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null; count?: number | null };
type QueryBuilder<T = unknown> = PromiseLike<DbResult<T>> & {
  select: (columns?: string, options?: unknown) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  neq: (column: string, value: unknown) => QueryBuilder<T>;
  gte: (column: string, value: unknown) => QueryBuilder<T>;
  lt: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: unknown[]) => QueryBuilder<T>;
  not: (column: string, operator: string, value: unknown) => QueryBuilder<T>;
  order: (column: string, options?: unknown) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  maybeSingle: () => Promise<DbResult<T>>;
  single: () => Promise<DbResult<T>>;
  insert: (values: unknown) => QueryBuilder<T>;
  update: (values: unknown) => QueryBuilder<T>;
  delete: () => QueryBuilder<T>;
  upsert: (values: unknown, options?: unknown) => QueryBuilder<T>;
};
type LooseDb = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
  from: <T = unknown>(table: string) => QueryBuilder<T>;
};

type AuthUserRow = {
  id: string;
  email?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
};

type TenantRow = {
  id: string;
  nome: string;
  slug: string;
  status: string;
  plano: string;
  crm_model?: string | null;
  limits?: Json | null;
  metadata?: Json | null;
  created_at: string;
  updated_at: string | null;
  // Not in the generated Supabase types yet (added via migration only, Task
  // 1); follows the established `(supabaseAdmin as any)` / loose-row-type
  // pattern used elsewhere for this column.
  is_demo?: boolean | null;
};

type TenantMemberRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  role: TenantAssignableRole;
  created_at: string;
};

type TenantAssignableRole = "admin" | "gestor" | "member";
type ServerContext = {
  userId: string;
  supabase: LooseDb;
  activeTenantId?: string | null;
};

const db = () => supabaseAdmin as unknown as LooseDb;
const tenantRole = z.enum(["admin", "gestor", "member"]);
const tenantStatus = z.enum(["active", "suspended", "trial", "canceled"]);
const tenantPlan = z.enum(["starter", "pro", "enterprise", "interno"]);
const crmModel = z.enum(["CRM_PLATAFORMA", "CRM_EXPERT"]);

function normalizeSlug(input: string) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

async function assertSuperAdmin(userId: string) {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas o super admin pode realizar esta ação");
}

async function checkSuperAdmin(userId: string) {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return !!data;
}

/**
 * True only for a real manager of a group containing the house (super admin
 * deliberately does not count, see is_group_manager_of_tenant in SQL).
 */
async function checkGroupManagerOfTenant(userId: string, tenantId: string) {
  const { data, error } = await db().rpc<boolean>("is_group_manager_of_tenant", {
    _user: userId,
    _tenant: tenantId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

async function isSuperAdminOrTenantAdmin(ctx: ServerContext, tenantId: string) {
  if (await checkSuperAdmin(ctx.userId)) return true;
  const { data, error } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", ctx.userId)
    .eq("role", "admin");
  if (error) throw new Error(error.message);
  return !!data?.length;
}

/**
 * People management (add/change/remove members): super admin, house admin, or
 * a manager of a group containing the house. Never used for operational or
 * settings access — see requireTenantSettingsManager.
 */
async function canManageTenant(ctx: ServerContext, tenantId: string) {
  if (await isSuperAdminOrTenantAdmin(ctx, tenantId)) return true;
  return checkGroupManagerOfTenant(ctx.userId, tenantId);
}

async function requireTenantManager(ctx: ServerContext, tenantId: string) {
  const allowed = await canManageTenant(ctx, tenantId);
  if (!allowed) throw new Error("Sem permissão para gerenciar este tenant");
}

/** House settings stay limited to super admin and house admin (no group-manager path). */
async function requireTenantSettingsManager(ctx: ServerContext, tenantId: string) {
  const allowed = await isSuperAdminOrTenantAdmin(ctx, tenantId);
  if (!allowed) throw new Error("Sem permissão para gerenciar este tenant");
}

/** Super admin, or a manager of a group containing the house, may name/change/remove admins. */
async function checkActorCanSetAdmin(ctx: ServerContext, tenantId: string) {
  if (await checkSuperAdmin(ctx.userId)) return true;
  return checkGroupManagerOfTenant(ctx.userId, tenantId);
}

async function countTenantAdmins(tenantId: string) {
  const { data, error } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", tenantId)
    .eq("role", "admin");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function getAccessibleTenants(ctx: ServerContext) {
  const superAdmin = await checkSuperAdmin(ctx.userId);
  if (superAdmin) {
    const { data, error } = await db()
      .from<TenantRow[]>("tenants")
      .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at,is_demo")
      .order("nome", { ascending: true });
    if (error) throw new Error(error.message);
    return { superAdmin, tenants: data ?? [] };
  }

  const { data: roles, error: rolesErr } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("tenant_id")
    .eq("user_id", ctx.userId)
    .not("tenant_id", "is", null);
  if (rolesErr) throw new Error(rolesErr.message);

  const tenantIds = Array.from(new Set((roles ?? []).map((r) => r.tenant_id).filter(Boolean)));
  if (!tenantIds.length) return { superAdmin, tenants: [] as TenantRow[] };

  const { data, error } = await db()
    .from<TenantRow[]>("tenants")
    .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at,is_demo")
    .in("id", tenantIds)
    .order("nome", { ascending: true });
  if (error) throw new Error(error.message);
  return { superAdmin, tenants: data ?? [] };
}

async function countRows(table: string, tenantId: string, from?: string) {
  let query = db()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (from) query = query.gte("created_at", from);
  const { count, error } = await query;
  if (error) {
    console.warn(`[tenants] failed counting ${table}`, error.message);
    return 0;
  }
  return count ?? 0;
}

export async function listAuthUsersById(userIds: string[]) {
  const wanted = new Set(userIds);
  const map = new Map<string, AuthUserRow>();
  let page = 1;
  const perPage = 1000;

  while (wanted.size && page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    for (const user of data.users ?? []) {
      if (wanted.has(user.id)) {
        map.set(user.id, {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at,
          banned_until: user.banned_until,
        });
        wanted.delete(user.id);
      }
    }
    if ((data.users ?? []).length < perPage) break;
    page += 1;
  }

  return map;
}

export async function findAuthUserByEmail(email: string) {
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;

  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const found = (data.users ?? []).find((user) => user.email?.toLowerCase() === target);
    if (found) return found;
    if ((data.users ?? []).length < perPage) break;
    page += 1;
  }

  return null;
}

/** Members of a house (user_roles) with their auth e-mail and sign-in data, oldest first. */
export async function listTenantMembers(tenantId: string) {
  const { data, error } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const members = data ?? [];
  const userMap = await listAuthUsersById(members.map((m) => m.user_id));
  return members.map((member) => ({
    ...member,
    email: userMap.get(member.user_id)?.email ?? null,
    last_sign_in_at: userMap.get(member.user_id)?.last_sign_in_at ?? null,
    banned_until: userMap.get(member.user_id)?.banned_until ?? null,
  }));
}

async function buildTenantDetail(tenantId: string) {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    tenantRes,
    users,
    smsSummaryRes,
    pricingRes,
    ledgerRes,
    ordersRes,
    auditRes,
    playerCount,
    sms30,
    email30,
    calls30,
    webhook30,
    metaAccounts,
  ] = await Promise.all([
    db()
      .from<TenantRow>("tenants")
      .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at")
      .eq("id", tenantId)
      .maybeSingle(),
    listTenantMembers(tenantId),
    db().rpc("sms_credit_summary", { _tenant: tenantId }),
    db().rpc("sms_effective_pricing", { _tenant: tenantId }),
    db()
      .from("sms_credit_ledger")
      .select(
        "id,delta_credits,balance_after,entry_type,reason,reference_type,created_by,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(25),
    db()
      .from("sms_credit_orders")
      .select(
        "id,credits,amount_cents,currency,status,checkout_provider,external_reference,created_at,paid_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(20),
    db()
      .from("tenant_audit_logs")
      .select(
        "id,actor_user_id,action,entity_type,entity_id,before_data,after_data,metadata,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(40),
    countRows("players", tenantId),
    countRows("sms_send_logs", tenantId, since30),
    countRows("email_send_logs", tenantId, since30),
    countRows("call_history", tenantId, since30),
    countRows("webhook_logs", tenantId, since30),
    countRows("meta_ad_accounts", tenantId),
  ]);

  if (tenantRes.error) throw new Error(tenantRes.error.message);
  if (!tenantRes.data) throw new Error("Tenant não encontrado");
  if (smsSummaryRes.error) throw new Error(smsSummaryRes.error.message);
  if (pricingRes.error) throw new Error(pricingRes.error.message);
  if (ledgerRes.error) throw new Error(ledgerRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (auditRes.error) throw new Error(auditRes.error.message);

  return {
    tenant: tenantRes.data,
    users,
    reports: {
      players_total: playerCount,
      sms_30d: sms30,
      email_30d: email30,
      calls_30d: calls30,
      webhooks_30d: webhook30,
      meta_accounts: metaAccounts,
    },
    sms: {
      summary: smsSummaryRes.data ?? {},
      pricing: pricingRes.data ?? {},
      ledger: ledgerRes.data ?? [],
      orders: ordersRes.data ?? [],
    },
    audit: auditRes.data ?? [],
  };
}

const consoleInput = z
  .object({
    tenantId: dbUuid().optional().nullable(),
  })
  .default({});

export const getTenantManagementConsole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => consoleInput.parse(data ?? {}))
  .handler(async ({ data, context }) =>
    getTenantManagementConsoleFor(context as unknown as ServerContext, data),
  );

// Body of `getTenantManagementConsole`, exported so its access rule (house
// role or super admin only; group managers get no path here) is unit-testable.
export async function getTenantManagementConsoleFor(
  ctx: ServerContext,
  data: z.infer<typeof consoleInput>,
) {
  const { superAdmin, tenants } = await getAccessibleTenants(ctx);
  const selectedTenantId = data.tenantId ?? tenants[0]?.id ?? null;

  if (!selectedTenantId) {
    return {
      isSuperAdmin: superAdmin,
      tenants,
      selectedTenantId: null,
      detail: null,
    };
  }

  if (!tenants.some((tenant) => tenant.id === selectedTenantId)) {
    throw new Error("Tenant sem acesso");
  }

  return {
    isSuperAdmin: superAdmin,
    canManage: await canManageTenant(ctx, selectedTenantId),
    tenants,
    selectedTenantId,
    detail: await buildTenantDetail(selectedTenantId),
  };
}

export async function checkFinanceCanView(userId: string, tenantId: string) {
  const { data, error } = await db().rpc<boolean>("finance_can_view", {
    _user: userId,
    _tenant: tenantId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * Group ids the user manages (all groups for a super admin). PostgREST returns
 * a `setof uuid` as a list of scalars; an object row is unwrapped defensively.
 */
export async function managedGroupIds(userId: string) {
  const { data, error } = await db().rpc<unknown[]>("group_ids_managed_by", { _user: userId });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) =>
      row && typeof row === "object" ? Object.values(row as Record<string, unknown>)[0] : row,
    )
    .filter((id): id is string => typeof id === "string");
}

type GroupOption = { id: string; nome: string; is_demo: boolean };

async function listManagedGroups(userId: string): Promise<GroupOption[]> {
  const ids = await managedGroupIds(userId);
  if (!ids.length) return [];
  const { data, error } = await db()
    .from<GroupOption[]>("tenant_groups")
    .select("id,nome,is_demo")
    .in("id", ids)
    .order("nome", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((group) => ({ id: group.id, nome: group.nome, is_demo: group.is_demo === true }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/**
 * Body of `getTenantSwitcher`, extracted so `is_demo` is directly
 * unit-testable (mirrors the existing `*For` convention used elsewhere in
 * this file for demo-sensitive handlers).
 */
export async function getTenantSwitcherFor(ctx: ServerContext) {
  const superAdmin = await checkSuperAdmin(ctx.userId);
  const { data: memberships, error: membershipErr } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("user_id", ctx.userId)
    .not("tenant_id", "is", null);
  if (membershipErr) throw new Error(membershipErr.message);

  const roles = memberships ?? [];
  const tenantIds = roles.map((membership) => membership.tenant_id);
  const { data: tenants, error: tenantsErr } = await db()
    .from<TenantRow[]>("tenants")
    .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at,is_demo")
    .in(
      "id",
      superAdmin ? (await getAccessibleTenants(ctx)).tenants.map((tenant) => tenant.id) : tenantIds,
    )
    .order("nome", { ascending: true });
  if (tenantsErr) throw new Error(tenantsErr.message);

  const roleByTenant = new Map(roles.map((membership) => [membership.tenant_id, membership.role]));
  const options = (tenants ?? []).map((tenant) => ({
    id: tenant.id,
    nome: tenant.nome,
    slug: tenant.slug,
    role: superAdmin ? "super_admin" : (roleByTenant.get(tenant.id) ?? "member"),
    is_demo: tenant.is_demo === true,
  }));
  // The switcher is on every page: a failing finance/group lookup must only
  // hide those entries, never break navigation. A super admin sees every
  // house's finance, so no per-house RPC is needed.
  const [canViewFinance, groups] = await Promise.all([
    Promise.all(
      options.map((tenant) =>
        superAdmin
          ? true
          : checkFinanceCanView(ctx.userId, tenant.id).catch((error: unknown) => {
              console.warn("[tenant-switcher] finance_can_view failed", tenant.id, error);
              return false;
            }),
      ),
    ),
    listManagedGroups(ctx.userId).catch((error: unknown) => {
      console.warn("[tenant-switcher] managed groups lookup failed", error);
      return [] as GroupOption[];
    }),
  ]);
  const activeTenantId = options.some((tenant) => tenant.id === ctx.activeTenantId)
    ? ctx.activeTenantId
    : (options[0]?.id ?? null);

  return {
    activeTenantId,
    tenants: options.map((tenant, index) => ({
      ...tenant,
      can_view_finance: canViewFinance[index],
    })),
    groups,
  };
}

export const getTenantSwitcher = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getTenantSwitcherFor(context as unknown as ServerContext));

export const getCurrentTenantAccessStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as unknown as ServerContext;
    const superAdmin = await checkSuperAdmin(ctx.userId);

    if (superAdmin) {
      return {
        isSuperAdmin: true,
        tenant: null,
        blocked: false,
      };
    }

    const { data: tenantId, error: tenantErr } =
      await ctx.supabase.rpc<string>("current_tenant_id");
    if (tenantErr) throw new Error(tenantErr.message);

    if (!tenantId) {
      return {
        isSuperAdmin: false,
        tenant: null,
        blocked: false,
      };
    }

    const { data: tenant, error } = await db()
      .from<TenantRow>("tenants")
      .select("id,nome,slug,status,plano,crm_model,created_at,updated_at")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const status = tenant?.status ?? null;

    return {
      isSuperAdmin: false,
      tenant,
      blocked: status === "suspended" || status === "canceled",
    };
  });

const createTenantInput = z.object({
  nome: z.string().min(2).max(160),
  slug: z.string().min(2).max(80).optional().nullable(),
  adminEmail: z.string().email().max(255),
  status: tenantStatus.default("trial"),
  plano: tenantPlan.default("starter"),
  crm_model: crmModel.default("CRM_PLATAFORMA"),
});

export const adminCreateTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createTenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const ctx = context as unknown as ServerContext;
    await assertSuperAdmin(ctx.userId);

    const slug = normalizeSlug(data.slug || data.nome);
    if (!slug) throw new Error("Slug inválido");

    const admin = await findAuthUserByEmail(data.adminEmail);
    if (!admin) throw new Error("O admin inicial precisa ser um usuário já cadastrado");

    const { data: tenant, error } = await db()
      .from<TenantRow>("tenants")
      .insert({
        nome: data.nome,
        slug,
        status: data.status,
        plano: data.plano,
        crm_model: data.crm_model,
      })
      .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at")
      .single();
    if (error) throw new Error(error.message);
    if (!tenant) throw new Error("Falha ao criar tenant");

    const { error: membershipErr } = await db().from("user_roles").insert({
      user_id: admin.id,
      tenant_id: tenant.id,
      role: "admin",
    });
    if (membershipErr) {
      await db().from("tenants").delete().eq("id", tenant.id);
      throw new Error(`Não foi possível definir o admin inicial: ${membershipErr.message}`);
    }

    await auditTenant({
      tenantId: tenant.id,
      actorUserId: ctx.userId,
      action: "tenant.created",
      entityType: "tenant",
      entityId: tenant.id,
      after: { ...tenant, initial_admin_user_id: admin.id, initial_admin_email: admin.email },
    });

    return { tenant };
  });

const updateTenantInput = z.object({
  tenantId: dbUuid(),
  nome: z.string().min(2).max(160),
  status: tenantStatus,
  plano: tenantPlan,
  crm_model: crmModel,
});

export const updateTenantSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateTenantInput.parse(data))
  .handler(async ({ data, context }) =>
    updateTenantSettingsFor(context as unknown as ServerContext, data),
  );

// Body of `updateTenantSettings`. Settings stay with super admin / house admin;
// a group manager has no settings path (requireTenantSettingsManager).
export async function updateTenantSettingsFor(
  ctx: ServerContext,
  data: z.infer<typeof updateTenantInput>,
) {
  const superAdmin = await checkSuperAdmin(ctx.userId);
  await requireTenantSettingsManager(ctx, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const { data: before, error: beforeErr } = await db()
    .from<TenantRow>("tenants")
    .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at")
    .eq("id", data.tenantId)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);
  if (!before) throw new Error("Tenant não encontrado");

  const patch = superAdmin
    ? {
        nome: data.nome,
        status: data.status,
        plano: data.plano,
        crm_model: data.crm_model,
        updated_at: new Date().toISOString(),
      }
    : {
        nome: data.nome,
        updated_at: new Date().toISOString(),
      };

  const { data: tenant, error } = await db()
    .from<TenantRow>("tenants")
    .update(patch)
    .eq("id", data.tenantId)
    .select("id,nome,slug,status,plano,crm_model,limits,metadata,created_at,updated_at")
    .single();
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant.updated",
    entityType: "tenant",
    entityId: data.tenantId,
    before,
    after: tenant,
    metadata: { limited_scope: !superAdmin },
  });

  return { tenant };
}

const addUserInput = z.object({
  tenantId: dbUuid(),
  email: z.string().email().max(255),
  role: tenantRole.default("member"),
  password: z.string().min(8).max(200).optional().nullable(),
});

export const addUserToTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => addUserInput.parse(data))
  .handler(async ({ data, context }) =>
    addUserToTenantFor(context as unknown as ServerContext, data),
  );

// Body of `addUserToTenant`, exported so the demo guard wiring is unit-testable.
export async function addUserToTenantFor(ctx: ServerContext, data: z.infer<typeof addUserInput>) {
  await requireTenantManager(ctx, data.tenantId);
  await assertTenantNotDemo(data.tenantId);
  const actorIsSuperAdmin = await checkSuperAdmin(ctx.userId);
  const actorCanSetAdmin = await checkActorCanSetAdmin(ctx, data.tenantId);

  if (!actorIsSuperAdmin && data.password) {
    throw new Error("Convites de tenant devem ser enviados por email, sem senha manual");
  }
  if (!actorCanSetAdmin && data.role === "admin") {
    throw new Error("Apenas o super admin ou o gestor do grupo pode definir o admin da casa");
  }

  const email = data.email.trim().toLowerCase();
  let user = await findAuthUserByEmail(email);
  let created = false;

  if (!user) {
    const createRes = data.password
      ? await supabaseAdmin.auth.admin.createUser({
          email,
          password: data.password,
          email_confirm: true,
          user_metadata: { invited_by: ctx.userId, tenant_id: data.tenantId },
          app_metadata: { force_password_change: true },
        })
      : await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
          data: { invited_by: ctx.userId, tenant_id: data.tenantId },
        });
    if (createRes.error) throw new Error(createRes.error.message);
    if (!createRes.data.user) throw new Error("Falha ao criar usuário");
    user = createRes.data.user;
    created = true;
  }

  if (!actorIsSuperAdmin && (await checkSuperAdmin(user.id))) {
    throw new Error("Não é permitido vincular um superadmin global por esta área");
  }

  const { data: existing, error: existingErr } = await db()
    .from<TenantMemberRow>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", data.tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    if (existing.role === data.role) return { ok: true, created, existing: true };
    // Same admin rules as updateTenantUserRole: re-adding an existing admin
    // with another role is a demotion.
    if (!actorCanSetAdmin && existing.role === "admin") {
      throw new Error("Apenas o super admin ou o gestor do grupo pode alterar o admin da casa");
    }
    if (existing.role === "admin" && (await countTenantAdmins(data.tenantId)) <= 1) {
      throw new Error("Nao e permitido remover o unico admin do tenant");
    }
    const { error } = await db()
      .from("user_roles")
      .update({ role: data.role })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    await auditTenant({
      tenantId: data.tenantId,
      actorUserId: ctx.userId,
      action: "tenant_user.role_changed",
      entityType: "user_role",
      entityId: existing.id,
      before: existing,
      after: { ...existing, role: data.role, email },
    });
    return { ok: true, created, existing: true };
  }

  const { data: membership, error } = await db()
    .from<TenantMemberRow>("user_roles")
    .insert({
      user_id: user.id,
      tenant_id: data.tenantId,
      role: data.role,
    })
    .select("id,user_id,tenant_id,role,created_at")
    .single();
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_user.added",
    entityType: "user_role",
    entityId: membership?.id ?? user.id,
    after: { ...membership, email },
    metadata: { auth_user_created: created },
  });

  return { ok: true, created, existing: false };
}

const updateUserRoleInput = z.object({
  tenantId: dbUuid(),
  membershipId: dbUuid(),
  role: tenantRole,
});

export const updateTenantUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateUserRoleInput.parse(data))
  .handler(async ({ data, context }) =>
    updateTenantUserRoleFor(context as unknown as ServerContext, data),
  );

// Body of `updateTenantUserRole`, exported so the admin rules are unit-testable.
export async function updateTenantUserRoleFor(
  ctx: ServerContext,
  data: z.infer<typeof updateUserRoleInput>,
) {
  await requireTenantManager(ctx, data.tenantId);
  await assertTenantNotDemo(data.tenantId);
  const actorCanSetAdmin = await checkActorCanSetAdmin(ctx, data.tenantId);

  if (!actorCanSetAdmin && data.role === "admin") {
    throw new Error("Apenas o super admin ou o gestor do grupo pode definir o admin da casa");
  }

  const { data: before, error: beforeErr } = await db()
    .from<TenantMemberRow>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("id", data.membershipId)
    .eq("tenant_id", data.tenantId)
    .maybeSingle();
  if (beforeErr) throw new Error(beforeErr.message);
  if (!before) throw new Error("Vínculo não encontrado");

  if (!actorCanSetAdmin && before.role === "admin") {
    throw new Error("Apenas o super admin ou o gestor do grupo pode alterar o admin da casa");
  }
  if (
    before.role === "admin" &&
    data.role !== "admin" &&
    (await countTenantAdmins(data.tenantId)) <= 1
  ) {
    throw new Error("Nao e permitido remover o unico admin do tenant");
  }

  const { data: after, error } = await db()
    .from<TenantMemberRow>("user_roles")
    .update({ role: data.role })
    .eq("id", data.membershipId)
    .eq("tenant_id", data.tenantId)
    .select("id,user_id,tenant_id,role,created_at")
    .single();
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_user.role_changed",
    entityType: "user_role",
    entityId: data.membershipId,
    before,
    after,
  });

  return { ok: true };
}

const removeUserInput = z.object({
  tenantId: dbUuid(),
  membershipId: dbUuid(),
});

export const removeUserFromTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => removeUserInput.parse(data))
  .handler(async ({ data, context }) =>
    removeUserFromTenantFor(context as unknown as ServerContext, data),
  );

// Body of `removeUserFromTenant`, exported so the admin rules are unit-testable.
export async function removeUserFromTenantFor(
  ctx: ServerContext,
  data: z.infer<typeof removeUserInput>,
) {
  await requireTenantManager(ctx, data.tenantId);
  await assertTenantNotDemo(data.tenantId);

  const { data: memberships, error: listErr } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", data.tenantId);
  if (listErr) throw new Error(listErr.message);
  if ((memberships ?? []).length <= 1) {
    throw new Error("Não é permitido remover o último usuário do tenant");
  }

  const before = (memberships ?? []).find((row) => row.id === data.membershipId);
  if (!before) throw new Error("Vínculo não encontrado");
  if (before.user_id === ctx.userId) {
    throw new Error("Você não pode remover seu próprio acesso por aqui");
  }

  const actorCanSetAdmin = await checkActorCanSetAdmin(ctx, data.tenantId);
  if (!actorCanSetAdmin && before.role === "admin") {
    throw new Error("Apenas o super admin ou o gestor do grupo pode remover o admin da casa");
  }
  if (before.role === "admin" && (await countTenantAdmins(data.tenantId)) <= 1) {
    throw new Error("Nao e permitido remover o unico admin do tenant");
  }

  const { error } = await db()
    .from("user_roles")
    .delete()
    .eq("id", data.membershipId)
    .eq("tenant_id", data.tenantId);
  if (error) throw new Error(error.message);

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant_user.removed",
    entityType: "user_role",
    entityId: data.membershipId,
    before,
  });

  return { ok: true };
}
