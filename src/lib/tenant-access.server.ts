import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DemoTenantBlockedError } from "@/lib/demo-tenant";
import { isEffectiveLock, type BillingAccessState } from "@/lib/billing/billing-view";
import { isSendBlockedError, TenantBillingLockedError } from "@/lib/billing/billing-locked-error";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type RpcClient = {
  // Supabase generates a literal union of RPC names. This structural boundary
  // intentionally accepts both that generated client and lightweight test doubles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (...args: any[]) => PromiseLike<DbResult<unknown>>;
};

type TenantStatusRow = {
  id: string;
  status: string | null;
  is_demo: boolean | null;
  /** `tenant_billing.access_state`; null when the house has no billing row. */
  billing_state: BillingAccessState | null;
};

// One query reads the tenant status, the demo flag and the billing state:
// `tenant_billing` is 1:1 with `tenants` (its PK is the FK), so PostgREST
// embeds it as an object (or null).
const TENANT_STATUS_COLUMNS = "id,status,is_demo,tenant_billing(access_state)";

type EmbeddedBilling = { access_state?: string | null };
type TenantStatusDbRow = {
  id: string;
  status: string | null;
  is_demo: boolean | null;
  tenant_billing?: EmbeddedBilling | EmbeddedBilling[] | null;
};

function toTenantStatusRow(data: TenantStatusDbRow | null): TenantStatusRow | null {
  if (!data) return null;
  const embedded = Array.isArray(data.tenant_billing)
    ? data.tenant_billing[0]
    : data.tenant_billing;
  return {
    id: data.id,
    status: data.status ?? null,
    is_demo: data.is_demo ?? null,
    billing_state: (embedded?.access_state as BillingAccessState | null | undefined) ?? null,
  };
}

let enforcementWithoutInvoicesReported = false;

/** Test-only: lets the misconfiguration error be observed again. */
export function __resetBillingEnforcementWarningForTests() {
  enforcementWithoutInvoicesReported = false;
}

/**
 * `BILLING_ENFORCEMENT_ENABLED === "true"` turns on the lock for unpaid
 * houses — but only together with `BILLING_INVOICES_ENABLED === "true"`.
 * Enforcement without invoices would lock houses that never got an invoice
 * or e-mail to pay, so that combination fails closed to "no lock" and logs
 * one console.error per process.
 */
export function isBillingEnforcementEnabled(): boolean {
  if (process.env.BILLING_ENFORCEMENT_ENABLED !== "true") return false;
  if (process.env.BILLING_INVOICES_ENABLED === "true") return true;
  if (!enforcementWithoutInvoicesReported) {
    enforcementWithoutInvoicesReported = true;
    console.error(
      "[billing] BILLING_ENFORCEMENT_ENABLED=true is ignored: BILLING_INVOICES_ENABLED is not \"true\". No house is locked for an unpaid invoice.",
    );
  }
  return false;
}

/**
 * The house's effective billing lock, before the superadmin exemption:
 * `frozen`/`locked_manual` always, `locked_unpaid`/`awaiting_first_payment`
 * only with enforcement on. A house without a billing row is never locked.
 */
function hasEffectiveBillingLock(tenant: TenantStatusRow | null): boolean {
  if (!tenant?.billing_state) return false;
  return isEffectiveLock(tenant.billing_state, isBillingEnforcementEnabled());
}

const blockedOperationalStatuses = new Set(["suspended", "canceled"]);

// In-memory cache for the guard lookups (send/action guards), 5s TTL. A miss
// or an unknown tenant is never cached as "allowed" — only resolved rows are
// cached, and only after they are read fresh from the DB.
const TENANT_STATUS_CACHE_TTL_MS = 5000;
type CachedTenantStatus = { tenant: TenantStatusRow | null; expiresAt: number };
let tenantStatusCache = new Map<string, CachedTenantStatus>();

/** Test-only: clears the guard cache so each test starts from a clean state. */
export function __resetDemoTenantCacheForTests() {
  tenantStatusCache = new Map();
}

/**
 * Drops one tenant from the 5 s guard cache, so the next guard reads its
 * status (and billing state) fresh — e.g. right after an invoice is settled,
 * so the house unlocks at once in this process.
 */
export function invalidateTenantStatusCache(tenantId: string) {
  tenantStatusCache.delete(tenantId);
}

async function getCachedTenantStatus(tenantId: string): Promise<TenantStatusRow | null> {
  const cached = tenantStatusCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  // `is_demo` is not yet in the generated Supabase types (Task 1 added the
  // column via migration only); follow the established pattern in this
  // codebase of casting to `any` for columns ahead of codegen.
  const { data, error } = await (supabaseAdmin as any)
    .from("tenants")
    .select(TENANT_STATUS_COLUMNS)
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const tenant = toTenantStatusRow((data as TenantStatusDbRow | null) ?? null);
  tenantStatusCache.set(tenantId, { tenant, expiresAt: Date.now() + TENANT_STATUS_CACHE_TTL_MS });
  return tenant;
}

/** The house's billing state from the 5 s guard cache (null without a billing row). */
export async function getCachedTenantBillingState(
  tenantId: string,
): Promise<BillingAccessState | null> {
  const tenant = await getCachedTenantStatus(tenantId);
  return tenant?.billing_state ?? null;
}

export type DemoTenantCheck = "demo" | "not_demo";

/**
 * Tri-state demo check for INBOUND traffic (house webhooks, Evolution
 * events, click redirects, unsubscribe tokens): `"demo"` only for a tenant
 * row with `is_demo = true`, `"not_demo"` otherwise — an unknown tenant is
 * NOT demo here, since every inbound call site resolves `tenantId` from an
 * already-validated foreign key (webhook token, whatsapp_sessions,
 * link_dispatches, email_unsubscribe_tokens), so "unknown" never happens on
 * the real path.
 *
 * R11: a lookup failure is never a definitive outcome — it is neither
 * `"demo"` nor `"not_demo"`, so this throws instead of guessing. Each caller
 * decides what "could not verify" means for its own route (503 for a
 * webhook a provider retries, the existing error/retry state for a
 * user-facing confirmation, a reported-but-neutral redirect for an
 * unauthenticated click) — never silently falling through to "not demo"
 * (which would write into an unverified tenant) nor silently answering
 * "demo" as if it were certain.
 */
export async function checkDemoTenant(tenantId: string): Promise<DemoTenantCheck> {
  const tenant = await getCachedTenantStatus(tenantId);
  return tenant?.is_demo === true ? "demo" : "not_demo";
}

/** The user's active tenant (`current_tenant_id()`), with no billing check. */
async function currentTenantIdOf(supabase: RpcClient) {
  const { data, error } = await supabase.rpc("current_tenant_id");
  if (error) throw new Error(error.message);
  const tenantId = data ?? null;
  if (!tenantId) throw new Error("tenant nao encontrado para o usuario");
  return String(tenantId);
}

/**
 * Super admin check for the caller of a user-scoped client:
 * `is_super_admin()` defaults `_user_id` to `auth.uid()`.
 */
async function callerIsSuperAdmin(supabase: RpcClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_super_admin");
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * Refuses a house with an effective billing lock unless the caller is the
 * superadmin (never locked). `superAdmin` is passed when already known; when
 * null it is asked through the caller's own client, and only for a locked
 * house, so an unlocked house costs no extra query.
 */
async function assertNotBillingLockedForCaller(
  supabase: RpcClient,
  tenant: TenantStatusRow | null,
  superAdmin: boolean | null,
) {
  if (!hasEffectiveBillingLock(tenant)) return;
  const isSuperAdmin = superAdmin ?? (await callerIsSuperAdmin(supabase));
  if (!isSuperAdmin) throw new TenantBillingLockedError();
}

/**
 * The billing-lock half of `resolveCurrentTenantId`, for the few callers that
 * must read `current_tenant_id` themselves (they tolerate a missing tenant or
 * filter differently for the superadmin). `superAdmin` when already known.
 */
export async function assertCallerNotBillingLocked(
  supabase: RpcClient,
  tenantId: string,
  superAdmin: boolean | null = null,
) {
  await assertNotBillingLockedForCaller(supabase, await getCachedTenantStatus(tenantId), superAdmin);
}

/**
 * The caller's active tenant. A house with an effective billing lock is
 * refused (`TenantBillingLockedError`) unless the caller is the superadmin;
 * the lock is read from the 5 s tenant-status cache. Billing screens use
 * `resolveTenantForBilling` instead, which never refuses a locked house.
 */
export async function resolveCurrentTenantId(supabase: RpcClient) {
  const tenantId = await currentTenantIdOf(supabase);
  await assertNotBillingLockedForCaller(supabase, await getCachedTenantStatus(tenantId), null);
  return tenantId;
}

async function resolveTenantSelection(
  supabase: RpcClient,
  userId: string,
  requestedTenantId?: string | null,
): Promise<{ tenantId: string; isSuperAdmin: boolean }> {
  const { data: isSuperAdmin, error: roleError } = await supabase.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (roleError) throw new Error(roleError.message);

  if (isSuperAdmin) {
    if (!requestedTenantId) throw new Error("Selecione uma conta para consultar os dados.");
    return { tenantId: requestedTenantId, isSuperAdmin: true };
  }

  const activeTenantId = await currentTenantIdOf(supabase);
  if (requestedTenantId && requestedTenantId !== activeTenantId) {
    throw new Error("Sem acesso aos dados desta conta.");
  }
  return { tenantId: activeTenantId, isSuperAdmin: false };
}

/**
 * Selects the operational tenant for an authenticated server action.
 *
 * Regular users are always bound to their active tenant. A requested tenant
 * is accepted only for a global super admin, which is the one role allowed to
 * inspect every account from the administration/dashboard screens. A house
 * with an effective billing lock is refused for everyone but the superadmin.
 */
export async function resolveOperationalTenantForRequest(
  supabase: RpcClient,
  userId: string,
  requestedTenantId?: string | null,
) {
  const { tenantId, isSuperAdmin } = await resolveTenantSelection(
    supabase,
    userId,
    requestedTenantId,
  );
  if (!isSuperAdmin) {
    await assertNotBillingLockedForCaller(supabase, await getCachedTenantStatus(tenantId), false);
  }
  return tenantId;
}

/**
 * `resolveOperationalTenantForRequest` without the billing lock: the only
 * resolver the billing server functions (Plano e créditos, Pix purchase,
 * invoice payment) use, so a locked house can still pay.
 */
export async function resolveTenantForBilling(
  supabase: RpcClient,
  userId: string,
  requestedTenantId?: string | null,
) {
  return (await resolveTenantSelection(supabase, userId, requestedTenantId)).tenantId;
}

/**
 * Admin-only actions of the active tenant. `is_tenant_admin` reads auth.uid(),
 * so it must run on the user's own client; it is true for an admin of that
 * tenant or a super admin. Never use the global has_role(uid, 'admin') here:
 * it says nothing about WHICH tenant the user administers.
 */
export async function requireTenantAdmin(supabase: RpcClient, tenantId: string, message: string) {
  const { data, error } = await supabase.rpc("is_tenant_admin", { _tenant: tenantId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error(message);
  return tenantId;
}

export async function requireActiveTenantAdmin(supabase: RpcClient, message: string) {
  const tenantId = await resolveCurrentTenantId(supabase);
  return requireTenantAdmin(supabase, tenantId, message);
}

export async function getTenantStatus(tenantId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("tenants")
    .select(TENANT_STATUS_COLUMNS)
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const tenant = toTenantStatusRow((data as TenantStatusDbRow | null) ?? null);
  if (!tenant) throw new Error("Tenant nao encontrado");
  return tenant;
}

/**
 * Refuses a suspended/canceled tenant, and a house with an effective billing
 * lock. The billing lock is lifted only for the superadmin, which needs the
 * caller's own client (`actor`): without it (workers, sends) a locked house
 * is always refused.
 */
export async function assertTenantCanOperate(tenantId: string, actor?: RpcClient) {
  const tenant = await getTenantStatus(tenantId);
  if (tenant.status && blockedOperationalStatuses.has(tenant.status)) {
    throw new Error("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
  }
  if (hasEffectiveBillingLock(tenant)) {
    if (!actor || !(await callerIsSuperAdmin(actor))) throw new TenantBillingLockedError();
  }
  return tenant;
}

export async function assertTenantCanOpenBilling(tenantId: string) {
  const tenant = await getTenantStatus(tenantId);
  if (tenant.status === "canceled") {
    throw new Error("Tenant cancelado nao pode iniciar novas compras de credito.");
  }
  return tenant;
}

/**
 * The caller's active tenant, refused when suspended/canceled or (for anyone
 * but the superadmin) under an effective billing lock. One tenant read: the
 * billing lock comes from the same row `assertTenantCanOperate` reads.
 */
export async function resolveOperationalTenantId(supabase: RpcClient) {
  const tenantId = await currentTenantIdOf(supabase);
  await assertTenantCanOperate(tenantId, supabase);
  return tenantId;
}

/**
 * Fail-closed guard placed immediately before any real network call to a
 * provider (SMS, WhatsApp, email, voice, AI, link shortening, ...). A
 * null/undefined tenant id, an unknown tenant, or a demo tenant are all
 * refused with `DemoTenantBlockedError("DEMO_SEND_BLOCKED")` so nothing is
 * ever sent/recorded as sent on their behalf. A suspended/canceled tenant
 * keeps the existing `assertTenantCanOperate` message. A house with an
 * effective billing lock is refused with `TenantBillingLockedError` for
 * everyone: sends are not user-scoped, so the superadmin exemption does not
 * apply here.
 */
export async function assertTenantCanSendExternally(tenantId: string | null | undefined) {
  if (!tenantId) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");

  const tenant = await getCachedTenantStatus(tenantId);
  if (!tenant) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (tenant.is_demo) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (tenant.status && blockedOperationalStatuses.has(tenant.status)) {
    throw new Error("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
  }
  if (hasEffectiveBillingLock(tenant)) throw new TenantBillingLockedError();
}

/**
 * The demo half of `assertTenantCanSendExternally`, plus the billing lock,
 * for channels that never checked the tenant's billing status before
 * (e-mail, external webhook, Short.io, ElevenLabs): throws
 * `DemoTenantBlockedError` (`DEMO_SEND_BLOCKED`, fail-closed for
 * null/undefined/unknown/demo) or `TenantBillingLockedError` (effective
 * billing lock, for everyone), and leaves suspended/canceled tenants to each
 * channel's existing rules. A failed tenant lookup throws its own error
 * (also blocking the send).
 *
 * `allowBillingLocked` is only for calls that READ data back from a provider
 * for the house (Short.io click statistics): like the house's inbound
 * webhook, they keep working while the house is locked.
 */
export async function assertTenantNotDemoForSend(
  tenantId: string | null | undefined,
  options: { allowBillingLocked?: boolean } = {},
) {
  if (!tenantId) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  // Decided on the row itself, never by catching errors: a failed lookup
  // propagates, so the send is refused (fail-closed).
  const tenant = await getCachedTenantStatus(tenantId);
  if (!tenant || tenant.is_demo) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (!options.allowBillingLocked && hasEffectiveBillingLock(tenant)) {
    throw new TenantBillingLockedError();
  }
}

/**
 * `assertTenantNotDemoForSend` for senders whose contract is a result object:
 * the refusal message (`DEMO_SEND_BLOCKED` copy or the billing lock copy)
 * when the tenant is refused, else null. A lookup error is rethrown (the
 * send never happens).
 */
export async function demoSendBlockedReason(
  tenantId: string | null | undefined,
  options: { allowBillingLocked?: boolean } = {},
): Promise<string | null> {
  try {
    await assertTenantNotDemoForSend(tenantId, options);
    return null;
  } catch (error) {
    if (isSendBlockedError(error)) return (error as Error).message;
    throw error;
  }
}

/**
 * Guard for non-send actions that must also be unavailable on a demo tenant
 * (integration connections, team management, config changes, ...).
 */
export async function assertTenantNotDemo(tenantId: string) {
  const tenant = await getCachedTenantStatus(tenantId);
  if (!tenant || tenant.is_demo) throw new DemoTenantBlockedError("DEMO_ACTION_BLOCKED");
}

/** All tenant ids currently flagged `is_demo = true`. */
export async function listDemoTenantIds(): Promise<string[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("tenants")
    .select("id")
    .eq("is_demo", true);
  if (error) throw new Error(error.message);
  return ((data as Array<{ id: string }> | null) ?? []).map((row) => row.id);
}
