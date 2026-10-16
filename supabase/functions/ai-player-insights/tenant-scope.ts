// Tenant scoping for ai-player-insights (F0-02 / SEC-10).
//
// The function runs with the service role, so RLS does not apply: the tenant
// chosen here and the scoped reader below are the only barrier between
// houses. Kept free of Deno and npm imports so vitest can cover it.

export type RoleRow = { role: string; tenant_id: string | null };

export type TenantDecision =
  { ok: true; tenantId: string } | { ok: false; status: 400 | 403; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBERSHIP_ROLES = new Set(["admin", "gestor", "member"]);
const INSIGHTS_ROLES = new Set(["admin", "gestor"]);

/** Tenant asked by the caller: body `tenant_id` first, then the X-Active-Tenant header. */
export function requestedTenantFrom(body: unknown, header: string | null): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.tenant_id ?? b.tenantId ?? header;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || null;
}

/**
 * Picks the tenant the question runs against and authorizes the caller on it.
 *
 * Without an explicit tenant it mirrors public.current_tenant_id(): the first
 * membership by tenant id. A super admin has no implicit tenant and must name
 * one. Everyone else must be admin or gestor OF THAT tenant; being admin of a
 * different house is not enough (that was the has_role(uid,'admin') bug).
 */
export function resolveInsightsTenant(roles: RoleRow[], requested: string | null): TenantDecision {
  if (requested && !UUID_RE.test(requested)) {
    return { ok: false, status: 400, error: "Conta inválida" };
  }
  const isSuperAdmin = roles.some((r) => r.role === "super_admin");
  const fallback =
    roles
      .filter((r) => r.tenant_id && MEMBERSHIP_ROLES.has(r.role))
      .map((r) => r.tenant_id as string)
      .sort()[0] ?? null;
  const tenantId = requested ?? (isSuperAdmin ? null : fallback);
  if (!tenantId) {
    return isSuperAdmin
      ? { ok: false, status: 400, error: "Selecione uma conta para consultar os dados." }
      : { ok: false, status: 403, error: "Forbidden" };
  }
  if (isSuperAdmin) return { ok: true, tenantId };
  const allowed = roles.some((r) => r.tenant_id === tenantId && INSIGHTS_ROLES.has(r.role));
  return allowed ? { ok: true, tenantId } : { ok: false, status: 403, error: "Forbidden" };
}

// deno-lint-ignore no-explicit-any
type AnyClient = { from: (table: string) => any };

/**
 * Read-only view of the database pinned to one tenant: every
 * `.from(table).select(...)` comes back already filtered by `tenant_id`, so
 * no query in the function can forget the filter. It has no write methods on
 * purpose; writes (ai_logs) go through the raw client with tenant_id set.
 */
export function tenantScopedReader(sb: AnyClient, tenantId: string) {
  if (!tenantId) throw new Error("tenant obrigatório");
  return {
    from(table: string) {
      return {
        select(columns?: string, options?: unknown) {
          return sb.from(table).select(columns, options).eq("tenant_id", tenantId);
        },
      };
    },
  };
}
