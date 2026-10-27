import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  getTenantBillingSnapshot,
  isTenantPayer,
  type BillingSnapshotInvoice,
} from "@/lib/billing/billing-state.server";
import {
  isEffectiveLock,
  type BillingAccessState,
  type BillingRole,
} from "@/lib/billing/billing-view";
import { cancelOpenInvoiceCharges } from "@/lib/billing/invoices.server";
import { EXPERT_MEMBER_GUARD, HOUSE_MEMBER_ROLES } from "@/lib/house-member-roles";
import { assertTenantNotDemo, isBillingEnforcementEnabled } from "@/lib/tenant-access.server";
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
  // `expert` rows live in user_roles too (Área do Expert), but are managed
  // only in Experts — never assigned from the team screen.
  role: TenantAssignableRole | "expert";
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

  // Team roles only: an `expert` row must never open the house console
  // (team, wallet, ledger, audit log...), which is read via supabaseAdmin.
  const { data: roles, error: rolesErr } = await db()
    .from<TenantMemberRow[]>("user_roles")
    .select("tenant_id")
    .eq("user_id", ctx.userId)
    .in("role", [...HOUSE_MEMBER_ROLES])
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

/**
 * Finds the auth user for `email`, or creates one: an e-mail invite
 * (`inviteUserByEmail`) by default, or — only when `password` is given — a
 * confirmed user with that password who must change it on first sign-in.
 * Shared by the team screen (`addUserToTenantFor`) and Experts
 * (`inviteExpertFor`). An existing user is reused as-is (`created: false`).
 */
export async function findOrInviteUserByEmail(
  email: string,
  opts: { invitedBy: string; tenantId: string; password?: string | null },
): Promise<{ userId: string; created: boolean }> {
  const normalized = email.trim().toLowerCase();
  const existing = await findAuthUserByEmail(normalized);
  if (existing) return { userId: existing.id, created: false };

  const metadata = { invited_by: opts.invitedBy, tenant_id: opts.tenantId };
  const createRes = opts.password
    ? await supabaseAdmin.auth.admin.createUser({
        email: normalized,
        password: opts.password,
        email_confirm: true,
        user_metadata: metadata,
        app_metadata: { force_password_change: true },
      })
    : await supabaseAdmin.auth.admin.inviteUserByEmail(normalized, { data: metadata });
  if (createRes.error) throw new Error(createRes.error.message);
  if (!createRes.data.user) throw new Error("Falha ao criar usuário");
  return { userId: createRes.data.user.id, created: true };
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

/**
 * Keys that carry what Betleads pays the supplier: `provider_unit_cost` is
 * the current (PG1) key on `billing_effective_price`/`wallet_summary.prices.*`
 * /`admin_set_tenant_price`; `provider_cost_per_sms` is the legacy (pre-PG1)
 * key, still present verbatim in old `sms_credit_summary.pricing`/
 * `sms_effective_pricing` audit rows written before this migration. Only the
 * super admin may see either (or the margin derived from them).
 */
const PROVIDER_COST_KEYS = new Set(["provider_unit_cost", "provider_cost_per_sms"]);

/**
 * Recursively strips every `PROVIDER_COST_KEYS` entry from `value`, at any
 * depth — top level, nested one level in `prices.<item>` (wallet_summary) or
 * `pricing` (legacy sms_credit_summary), and inside arrays. Used both for the
 * live wallet summary and for historical audit rows (`before_data`/
 * `after_data`/`metadata`), which may carry either shape depending on when
 * they were written.
 */
function withoutProviderCost<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => withoutProviderCost(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (PROVIDER_COST_KEYS.has(key)) continue;
      out[key] = withoutProviderCost(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Audit rows written by the price-book and wallet admin actions (and, for
 * older rows, the legacy SMS-credit admin actions) carry the provider cost
 * in before/after/metadata, at any depth. Strip it the same way for anyone
 * who is not the super admin.
 */
type AuditRow = { [key: string]: Json };

function redactAuditJson(value: Json): Json {
  return withoutProviderCost(value);
}

function redactAuditRows(rows: AuditRow[]): AuditRow[] {
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of ["before_data", "after_data", "metadata", "before", "after"]) {
      if (key in copy) copy[key] = redactAuditJson(copy[key]);
    }
    return copy;
  });
}

async function buildTenantDetail(
  tenantId: string,
  { includeProviderCost }: { includeProviderCost: boolean },
) {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    tenantRes,
    users,
    walletSummaryRes,
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
    db().rpc("wallet_summary", { _tenant: tenantId }),
    // Never selects `provider_unit_cost`, regardless of who's asking: this
    // query always runs through `db()` (supabaseAdmin), which bypasses the
    // column grant that normally hides it from `authenticated`.
    db()
      .from("wallet_ledger")
      .select(
        "id,entry_type,item,units,free_units,usage_month,unit_price,amount,balance_after,reference_type,reference_id,reason,created_by,created_at",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(25),
    // Legacy pre-wallet orders: read-only now (PG2 brings the real Pix
    // checkout), kept so old purchase history doesn't disappear.
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
  if (walletSummaryRes.error) throw new Error(walletSummaryRes.error.message);
  if (ledgerRes.error) throw new Error(ledgerRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (auditRes.error) throw new Error(auditRes.error.message);

  const walletSummary = (walletSummaryRes.data ?? {}) as {
    exempt?: boolean;
    prices?: Record<
      string,
      {
        unit_price?: number;
        provider_unit_cost?: number;
        free_monthly_units?: number;
        source?: string;
      }
    >;
  };
  const smsPrice = walletSummary.prices?.sms ?? {};
  const pricing = {
    item: "sms",
    unit_price: Number(smsPrice.unit_price ?? 0),
    free_monthly_units: Number(smsPrice.free_monthly_units ?? 0),
    exempt: Boolean(walletSummary.exempt),
    has_tenant_override: smsPrice.source === "override",
    ...(includeProviderCost ? { provider_unit_cost: smsPrice.provider_unit_cost ?? null } : {}),
  };

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
      summary: includeProviderCost ? walletSummary : withoutProviderCost(walletSummary),
      pricing,
      ledger: ledgerRes.data ?? [],
      orders: ordersRes.data ?? [],
    },
    audit: includeProviderCost
      ? ((auditRes.data ?? []) as AuditRow[])
      : redactAuditRows((auditRes.data ?? []) as AuditRow[]),
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

// Body of `getTenantManagementConsole`, exported so it is unit-testable. Its
// access rule is house role or super admin only (getAccessibleTenants); group
// managers get no path here.
export async function getTenantManagementConsoleFor(
  ctx: ServerContext,
  data: { tenantId?: string | null },
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
    detail: await buildTenantDetail(selectedTenantId, { includeProviderCost: superAdmin }),
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

/** The billing block of `getCurrentTenantAccessStatus`, for the banner and lock UI. */
export type TenantAccessBilling = {
  state: BillingAccessState;
  /** The lock for THIS caller: always false for the superadmin. */
  effectiveLock: boolean;
  role: BillingRole;
  invoice: BillingSnapshotInvoice | null;
  enforcement: boolean;
  /** Brasília calendar day (YYYY-MM-DD), for `billingView`. */
  today: string;
};

function brasiliaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function tenantAccessBilling(
  ctx: ServerContext,
  tenantId: string,
  superAdmin: boolean,
): Promise<TenantAccessBilling> {
  const [snapshot, payer] = await Promise.all([
    getTenantBillingSnapshot(tenantId),
    superAdmin ? Promise.resolve(true) : isTenantPayer(ctx.supabase, tenantId, ctx.userId),
  ]);
  const enforcement = isBillingEnforcementEnabled();
  return {
    state: snapshot.state,
    effectiveLock: !superAdmin && isEffectiveLock(snapshot.state, enforcement),
    role: superAdmin ? "super_admin" : payer ? "payer" : "member",
    invoice: snapshot.invoice,
    enforcement,
    today: brasiliaToday(),
  };
}

/**
 * Status the UI gate polls. Never refused for a billing-locked house (it is
 * how the UI learns about the lock), so it reads the active tenant with the
 * raw `current_tenant_id` RPC, not a locking resolver.
 */
export async function getCurrentTenantAccessStatusFor(ctx: ServerContext) {
  const superAdmin = await checkSuperAdmin(ctx.userId);

  if (superAdmin) {
    // The superadmin is never locked, but sees the house's billing state
    // (banner) for the house currently selected, when there is one.
    let billing: TenantAccessBilling | null = null;
    const { data: activeTenantId } = await ctx.supabase.rpc<string>("current_tenant_id");
    if (activeTenantId) billing = await tenantAccessBilling(ctx, activeTenantId, true);
    return {
      isSuperAdmin: true,
      tenant: null,
      blocked: false,
      billing,
    };
  }

  const { data: tenantId, error: tenantErr } = await ctx.supabase.rpc<string>("current_tenant_id");
  if (tenantErr) throw new Error(tenantErr.message);

  if (!tenantId) {
    return {
      isSuperAdmin: false,
      tenant: null,
      blocked: false,
      billing: null,
    };
  }

  const [{ data: tenant, error }, billing] = await Promise.all([
    db()
      .from<TenantRow>("tenants")
      .select("id,nome,slug,status,plano,crm_model,created_at,updated_at")
      .eq("id", tenantId)
      .maybeSingle(),
    tenantAccessBilling(ctx, tenantId, false),
  ]);
  if (error) throw new Error(error.message);

  const status = tenant?.status ?? null;

  return {
    isSuperAdmin: false,
    tenant,
    blocked: status === "suspended" || status === "canceled",
    billing,
  };
}

export const getCurrentTenantAccessStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    getCurrentTenantAccessStatusFor(context as unknown as ServerContext),
  );

const createTenantInput = z.object({
  nome: z.string().min(2).max(160),
  slug: z.string().min(2).max(80).optional().nullable(),
  adminEmail: z.string().email().max(255),
  status: tenantStatus.default("trial"),
  plano: tenantPlan.default("starter"),
  // Criação de casa só aceita o modelo vigente; CRM_EXPERT foi descontinuado
  // (Task 3 da Área do Expert) e só sobrevive em casas legadas já nesse modelo.
  crm_model: z.enum(["CRM_PLATAFORMA"]).default("CRM_PLATAFORMA"),
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
  // Required (>= 5 chars) only when `plano` changes into or out of
  // 'interno'; optional otherwise (see `updateTenantSettingsFor` below).
  planReason: z.string().max(500).optional().nullable(),
});

/**
 * Body of `updateTenantSettings`, exported so the plan-reason rule is directly
 * unit-testable. Settings stay with super admin / house admin; a group manager
 * has no settings path (requireTenantSettingsManager).
 */
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

  // CRM_EXPERT foi descontinuado (Task 3 da Área do Expert): só continua
  // existindo em casas legadas que já estavam nesse modelo. Mudar uma casa
  // atual *para* CRM_EXPERT não é permitido; manter o valor já vigente é.
  if (data.crm_model === "CRM_EXPERT" && before.crm_model !== "CRM_EXPERT") {
    throw new Error(
      "O modelo CRM Expert foi descontinuado. Cadastre experts dentro da casa, em Experts.",
    );
  }

  // Only the super admin can actually change `plano` (the `patch` below
  // omits it otherwise, and `tenants_plan_guard` enforces the same rule at
  // the DB level), so the reason is only ever required on that branch.
  const planChanging = superAdmin && before.plano !== data.plano;
  const touchesInterno = planChanging && (before.plano === "interno" || data.plano === "interno");
  const planReason = (data.planReason ?? "").trim();
  if (touchesInterno && planReason.length < 5) {
    throw new Error("Informe o motivo da troca de plano");
  }

  // A house that becomes exempt has its open invoice canceled by the plano
  // trigger, but the invoice's Pix at Upper stays payable. Note the open
  // invoice before the update so its charges can be canceled afterwards.
  const openInvoiceBefore = planChanging ? await findOpenInvoiceId(data.tenantId) : null;

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

  const pixCancel = openInvoiceBefore ? await cancelPixOfClosedInvoice(openInvoiceBefore) : null;

  await auditTenant({
    tenantId: data.tenantId,
    actorUserId: ctx.userId,
    action: "tenant.updated",
    entityType: "tenant",
    entityId: data.tenantId,
    before,
    after: tenant,
    metadata: {
      limited_scope: !superAdmin,
      ...(touchesInterno ? { plan_reason: planReason } : {}),
      ...(pixCancel ? { pix_cancel: pixCancel } : {}),
    },
  });

  return { tenant };
}

async function findOpenInvoiceId(tenantId: string): Promise<string | null> {
  const { data, error } = await db()
    .from<{ id: string }>("billing_invoices")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

/**
 * After a plan change: if the invoice that was open before it is no longer
 * open (the plano trigger cancels it when the house becomes exempt), cancel
 * its Pix charges at Upper. Best-effort: the plan change already happened,
 * so a failure is logged and returned for the audit row, never thrown.
 */
async function cancelPixOfClosedInvoice(invoiceId: string) {
  try {
    const { data, error } = await db()
      .from<{ status: string }>("billing_invoices")
      .select("status")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.status === "open") return null;
    const { canceled, failed } = await cancelOpenInvoiceCharges(invoiceId);
    if (failed.length > 0) {
      console.error("[tenants] cancelOpenInvoiceCharges reported per-charge failures", failed);
    }
    return { invoiceId, ok: failed.length === 0, canceled, failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tenants] cancelOpenInvoiceCharges failed", message);
    return { invoiceId, ok: false, canceled: 0, failed: [{ chargeId: "unknown", error: message }] };
  }
}

export const updateTenantSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateTenantInput.parse(data))
  .handler(async ({ data, context }) =>
    updateTenantSettingsFor(context as unknown as ServerContext, data),
  );

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
  const { userId, created } = await findOrInviteUserByEmail(email, {
    invitedBy: ctx.userId,
    tenantId: data.tenantId,
    password: data.password,
  });

  if (!actorIsSuperAdmin && (await checkSuperAdmin(userId))) {
    throw new Error("Não é permitido vincular um superadmin global por esta área");
  }

  const { data: existing, error: existingErr } = await db()
    .from<TenantMemberRow>("user_roles")
    .select("id,user_id,tenant_id,role,created_at")
    .eq("tenant_id", data.tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    if (existing.role === "expert") throw new Error(EXPERT_MEMBER_GUARD);
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
      user_id: userId,
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
    entityId: membership?.id ?? userId,
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

// Body of `updateTenantUserRole`, exported so its guards are unit-testable.
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
  if (before.role === "expert") throw new Error(EXPERT_MEMBER_GUARD);

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

// Body of `removeUserFromTenant`, exported so its guards are unit-testable.
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
  if (before.role === "expert") throw new Error(EXPERT_MEMBER_GUARD);
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
