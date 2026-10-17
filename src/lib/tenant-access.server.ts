import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DemoTenantBlockedError, isDemoBlockedError } from "@/lib/demo-tenant";

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
};

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

async function getCachedTenantStatus(tenantId: string): Promise<TenantStatusRow | null> {
  const cached = tenantStatusCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;

  // `is_demo` is not yet in the generated Supabase types (Task 1 added the
  // column via migration only); follow the established pattern in this
  // codebase of casting to `any` for columns ahead of codegen.
  const { data, error } = await (supabaseAdmin as any)
    .from("tenants")
    .select("id,status,is_demo")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const tenant = (data as TenantStatusRow | null) ?? null;
  tenantStatusCache.set(tenantId, { tenant, expiresAt: Date.now() + TENANT_STATUS_CACHE_TTL_MS });
  return tenant;
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

export async function resolveCurrentTenantId(supabase: RpcClient) {
  const { data, error } = await supabase.rpc("current_tenant_id");
  if (error) throw new Error(error.message);
  const tenantId = data ?? null;
  if (!tenantId) throw new Error("tenant nao encontrado para o usuario");
  return String(tenantId);
}

/**
 * Selects the operational tenant for an authenticated server action.
 *
 * Regular users are always bound to their active tenant. A requested tenant
 * is accepted only for a global super admin, which is the one role allowed to
 * inspect every account from the administration/dashboard screens.
 */
export async function resolveOperationalTenantForRequest(
  supabase: RpcClient,
  userId: string,
  requestedTenantId?: string | null,
) {
  const { data: isSuperAdmin, error: roleError } = await supabase.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (roleError) throw new Error(roleError.message);

  if (isSuperAdmin) {
    if (!requestedTenantId) throw new Error("Selecione uma conta para consultar os dados.");
    return requestedTenantId;
  }

  const activeTenantId = await resolveCurrentTenantId(supabase);
  if (requestedTenantId && requestedTenantId !== activeTenantId) {
    throw new Error("Sem acesso aos dados desta conta.");
  }
  return activeTenantId;
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
    .select("id,status,is_demo")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Tenant nao encontrado");
  return data as TenantStatusRow;
}

export async function assertTenantCanOperate(tenantId: string) {
  const tenant = await getTenantStatus(tenantId);
  if (tenant.status && blockedOperationalStatuses.has(tenant.status)) {
    throw new Error("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
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

export async function resolveOperationalTenantId(supabase: RpcClient) {
  const tenantId = await resolveCurrentTenantId(supabase);
  await assertTenantCanOperate(tenantId);
  return tenantId;
}

/**
 * Fail-closed guard placed immediately before any real network call to a
 * provider (SMS, WhatsApp, email, voice, AI, link shortening, ...). A
 * null/undefined tenant id, an unknown tenant, or a demo tenant are all
 * refused with `DemoTenantBlockedError("DEMO_SEND_BLOCKED")` so nothing is
 * ever sent/recorded as sent on their behalf. A suspended/canceled tenant
 * keeps the existing `assertTenantCanOperate` message.
 */
export async function assertTenantCanSendExternally(tenantId: string | null | undefined) {
  if (!tenantId) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");

  const tenant = await getCachedTenantStatus(tenantId);
  if (!tenant) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (tenant.is_demo) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  if (tenant.status && blockedOperationalStatuses.has(tenant.status)) {
    throw new Error("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
  }
}

/**
 * The demo half of `assertTenantCanSendExternally`, for channels that never
 * checked the tenant's billing status before (e-mail, external webhook,
 * Short.io, ElevenLabs): throws only `DemoTenantBlockedError`
 * (`DEMO_SEND_BLOCKED`, fail-closed for null/undefined/unknown/demo) and
 * leaves suspended/canceled tenants to each channel's existing rules. A
 * failed tenant lookup throws its own error (also blocking the send).
 */
export async function assertTenantNotDemoForSend(tenantId: string | null | undefined) {
  if (!tenantId) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
  // Decided on the row itself, never by catching errors: a failed lookup
  // propagates, so the send is refused (fail-closed).
  const tenant = await getCachedTenantStatus(tenantId);
  if (!tenant || tenant.is_demo) throw new DemoTenantBlockedError("DEMO_SEND_BLOCKED");
}

/**
 * `assertTenantNotDemoForSend` for senders whose contract is a result object:
 * the `DEMO_SEND_BLOCKED` message when the tenant is refused, else null. A
 * lookup error is rethrown (the send never happens).
 */
export async function demoSendBlockedReason(
  tenantId: string | null | undefined,
): Promise<string | null> {
  try {
    await assertTenantNotDemoForSend(tenantId);
    return null;
  } catch (error) {
    if (isDemoBlockedError(error)) return error.message;
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
