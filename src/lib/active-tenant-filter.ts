/**
 * Explicit active-tenant filter for reads on the user-scoped client.
 *
 * RLS on tenant tables is `is_super_admin() OR tenant_id = current_tenant_id()`,
 * so a read relying on RLS alone shows a super admin every tenant, whatever
 * house the header switcher picked. `current_tenant_id()` is that house (the
 * X-Active-Tenant header) for a super admin and the membership tenant for
 * everyone else; no billing check here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function activeTenantFilter(sb: any): Promise<string | null> {
  const { data, error } = await sb.rpc("current_tenant_id");
  return error || !data ? null : String(data);
}

/** Adds `.eq("tenant_id", tenantId)` when there is an active tenant. */
export function scopeToTenant<Q>(query: Q, tenantId: string | null): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tenantId ? (query as any).eq("tenant_id", tenantId) : query;
}

/**
 * `sb.from` whose `.select(...)` is filtered by the active tenant (same
 * types as the client). For read handlers that used to rely on RLS alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tenantReads<C extends { from: (...args: any[]) => any }>(
  sb: C,
): Promise<{ tenantId: string | null; from: C["from"] }> {
  const tenantId = await activeTenantFilter(sb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (...args: any[]) => {
    const builder = sb.from(...args);
    const select = builder.select.bind(builder);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builder.select = (...selectArgs: any[]) => scopeToTenant(select(...selectArgs), tenantId);
    return builder;
  };
  return { tenantId, from: from as C["from"] };
}
