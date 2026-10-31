// MCP financeiro: write gate for blocked houses (Task 5). Re-checked inside
// every write-path `*For` function, independent of the list-only
// listFinanceScopesFor — a scope appearing in that listing never implies a
// write is allowed. See
// docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md §3-4.
import { isBillingLockedFor, isSuperAdminUser } from "@/lib/billing/billing-state.server";
import { getTenantStatus } from "@/lib/tenant-access.server";

const BLOCKED_STATUSES = new Set(["suspended", "canceled"]);

/**
 * Refuses an MCP write for a suspended/canceled house (super admin exempt
 * from that check) or one under an effective billing lock
 * (`isBillingLockedFor` already resolves false for the super admin on its
 * own). Read tools never call this; it only guards the write path.
 */
export async function assertMcpCanWrite(tenantId: string, userId: string): Promise<void> {
  const superAdmin = await isSuperAdminUser(userId);
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
