import { describe, expect, it, vi } from "vitest";

import { activeTenantFilter, tenantReads } from "@/lib/active-tenant-filter";

function fakeClient(currentTenant: string | null, rpcError = false) {
  const eq = vi.fn();
  const builder = {
    select: vi.fn((_columns?: string) => {
      const query = { eq: eq.mockImplementation(() => query), order: vi.fn((_column?: string) => query) };
      return query;
    }),
    update: vi.fn(),
  };
  const sb = {
    rpc: vi.fn(async () => (rpcError ? { data: null, error: new Error("x") } : { data: currentTenant, error: null })),
    from: vi.fn((_table: string) => builder),
  };
  return { sb, builder, eq };
}

describe("tenantReads", () => {
  it("filters every select by the active tenant (the super admin's switched house)", async () => {
    const { sb, eq } = fakeClient("tenant-a");
    const reads = await tenantReads(sb);
    reads.from("call_queue").select("id").order("created_at");
    expect(reads.tenantId).toBe("tenant-a");
    expect(sb.from).toHaveBeenCalledWith("call_queue");
    expect(eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("adds no filter when there is no active tenant (RLS decides)", async () => {
    const { sb, eq } = fakeClient(null);
    const reads = await tenantReads(sb);
    reads.from("call_queue").select("id");
    expect(eq).not.toHaveBeenCalled();
  });

  it("treats an RPC failure as no active tenant", async () => {
    const { sb } = fakeClient("tenant-a", true);
    await expect(activeTenantFilter(sb)).resolves.toBeNull();
  });
});
