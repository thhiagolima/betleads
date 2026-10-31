// MCP financeiro: write gate for blocked houses (Task 5). Re-checked inside
// every write-path `*For` function, independent of the list-only
// listFinanceScopesFor — a scope appearing in that listing never implies a
// write is allowed. See
// docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §3-4.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isBillingLockedFor } from "@/lib/billing/billing-state.server";
import { getTenantStatus } from "@/lib/tenant-access.server";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type LooseDb = { rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>> };

const db = () => supabaseAdmin as unknown as LooseDb;

const BLOCKED_STATUSES = new Set(["suspended", "canceled"]);

async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data, error } = await db().rpc<boolean>("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * Refuses an MCP write for a suspended/canceled house (super admin exempt
 * from that check) or one under an effective billing lock
 * (`isBillingLockedFor` already resolves false for the super admin on its
 * own). Read tools never call this; it only guards the write path.
 */
export async function assertMcpCanWrite(tenantId: string, userId: string): Promise<void> {
  const superAdmin = await isSuperAdmin(userId);
  if (!superAdmin) {
    const tenant = await getTenantStatus(tenantId);
    if (tenant.status && BLOCKED_STATUSES.has(tenant.status)) {
      throw new Error("Casa suspensa ou cancelada: só leitura pelo MCP.");
    }
  }

  if (await isBillingLockedFor(tenantId, userId)) {
    throw new Error("Casa bloqueada por cobrança: só leitura pelo MCP.");
  }
}
